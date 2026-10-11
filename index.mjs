// @ts-check
// career-ops-plugin-headcountlabs
// License: MIT · https://github.com/headcountlabs/career-ops-plugin-headcountlabs
// Guide: https://github.com/career-ops-hq/career-ops/blob/main/docs/PLUGINS.md
//
// Job search over the Headcount Labs jobs API: postings collected from ATS
// boards and company career sites, each with a link to the original posting.
// All HTTP goes through ctx.fetch, so the manifest allowedHosts guard applies.

const JOBS_URL = 'https://api.headcountlabs.com/v1/jobs';
const KEY_ENV = 'HEADCOUNTLABS_API_KEY';

// One request per entry per scan: the API's page size ceiling bounds max_jobs.
const PAGE_CEILING = 250;
const DEFAULT_MAX_JOBS = 25;
const DEFAULT_SINCE_DAYS = 2;
const REQUEST_TIMEOUT_MS = 12_000;
const DAY_MS = 86_400_000;

// Filter name -> value kind. The names are the API's own query parameters.
const FILTERS = {
  q: 'text',
  title: 'text',
  title_advanced: 'text',
  description_advanced: 'text',
  company: 'text',
  location: 'text',
  city: 'text',
  state: 'text',
  country: 'text',
  msa: 'text',
  work_arrangement: 'text',
  employment_type: 'text',
  source: 'text',
  exclude_source: 'text',
  pay_currency: 'text',
  pay_min: 'number',
  has_pay: 'boolean',
};

// A request must name what it is looking for, so a bare entry cannot page
// through the whole catalog and spend the month's allowance in one scan.
const SUBJECT_FILTERS = ['q', 'title', 'title_advanced', 'description_advanced', 'company'];

const ERROR_HINTS = {
  invalid_api_key: `the API key was rejected. Check ${KEY_ENV} in .env`,
  data_limit_exceeded: "this month's job allowance is used up. It resets on the 1st (UTC)",
  rate_limited: 'the request allowance is used up for now. Wait and scan again later',
  query_timeout: 'the search ran longer than 10 seconds. Add a filter such as country, state or company',
  catalog_unavailable: 'the catalog is being republished. Scan again in a few minutes',
};

function filterValue(name, raw) {
  const kind = FILTERS[name];
  if (kind === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`headcountlabs: filter "${name}" must be a number, got ${JSON.stringify(raw)}`);
    return String(n);
  }
  if (kind === 'boolean') {
    if (raw !== true && raw !== false) throw new Error(`headcountlabs: filter "${name}" must be true or false, got ${JSON.stringify(raw)}`);
    return String(raw);
  }
  const text = String(raw).trim();
  if (!text || text.length > 200) throw new Error(`headcountlabs: filter "${name}" must be 1-200 characters`);
  return text;
}

function wholeNumber(label, raw, fallback, max) {
  if (raw === undefined || raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`headcountlabs: ${label} must be a whole number, got ${JSON.stringify(raw)}`);
  return Math.min(n, max);
}

/**
 * Turn the user's filters into one API request URL.
 * @param {Record<string, unknown>} filters
 * @param {{ maxJobs?: unknown, sinceDays?: unknown, now?: number }} [opts]
 */
export function buildRequestUrl(filters, opts = {}) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
    throw new Error('headcountlabs: "filters" must be a map, for example { title_advanced: "data AND engineer", country: "US" }');
  }
  const unknown = Object.keys(filters).filter((name) => !(name in FILTERS));
  if (unknown.length) {
    throw new Error(`headcountlabs: unknown filter ${unknown.join(', ')}. Use any of: ${Object.keys(FILTERS).join(', ')}`);
  }
  if (!SUBJECT_FILTERS.some((name) => name in filters)) {
    throw new Error(`headcountlabs: set at least one of ${SUBJECT_FILTERS.join(', ')}`);
  }

  const maxJobs = wholeNumber('max_jobs', opts.maxJobs, DEFAULT_MAX_JOBS, PAGE_CEILING);
  if (maxJobs === 0) throw new Error('headcountlabs: max_jobs must be at least 1');
  const sinceDays = wholeNumber('since_days', opts.sinceDays, DEFAULT_SINCE_DAYS, 366);

  const url = new URL(JOBS_URL);
  for (const [name, raw] of Object.entries(filters)) url.searchParams.set(name, filterValue(name, raw));
  // curated_since is when a job entered the catalog, so a window in days means
  // "new to the catalog", whatever the employer's own posted date says.
  if (sinceDays > 0) {
    url.searchParams.set('curated_since', new Date((opts.now ?? Date.now()) - sinceDays * DAY_MS).toISOString());
  }
  url.searchParams.set('sort', 'updated');
  url.searchParams.set('limit', String(maxJobs));
  return url.href;
}

function known(field) {
  return field && field.state === 'known' ? field.value : undefined;
}

function webUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:' ? value : '';
  } catch {
    return '';
  }
}

function placeName(place) {
  if (!place || typeof place !== 'object') return '';
  return [place.city, place.state ?? place.region, place.country].filter((part) => typeof part === 'string' && part).join(', ');
}

function locationText(job) {
  const places = [...new Set((job.locations ?? []).map((loc) => placeName(known(loc))).filter(Boolean))];
  const shown = places.slice(0, 3).join('; ') + (places.length > 3 ? `; +${places.length - 3} more` : '');
  const remote = known(job.work_arrangement) === 'remote';
  if (!shown) return remote ? 'Remote' : '';
  return remote ? `${shown} (Remote)` : shown;
}

function yearlyPay(posting) {
  const pay = known(posting.pay);
  if (!pay || pay.interval !== 'year') return undefined;
  const min = Number.isFinite(pay.min) ? pay.min : undefined;
  const max = Number.isFinite(pay.max) ? pay.max : undefined;
  if (min === undefined && max === undefined) return undefined;
  return { ...(min !== undefined && { min }), ...(max !== undefined && { max }), currency: String(pay.currency ?? '').toUpperCase() };
}

/**
 * Map one API job to the career-ops Job shape, or null when it has no title or
 * no usable link. A job can hold several postings of the same opening; the
 * link is the first one the source still lists.
 * @param {any} job
 */
export function toJob(job) {
  const title = String(known(job?.title) ?? '').trim();
  const postings = Array.isArray(job?.postings) ? job.postings : [];
  const ordered = [...postings.filter((p) => p.posting_status === 'listed'), ...postings.filter((p) => p.posting_status !== 'listed')];
  const posting = ordered.find((p) => webUrl(known(p.posting_url)) || webUrl(known(p.application_url)));
  if (!title || !posting) return null;

  const out = {
    title,
    url: webUrl(known(posting.posting_url)) || webUrl(known(posting.application_url)),
    company: String(known(job.employer_name) ?? ''),
    location: locationText(job),
  };
  const description = known(job.description);
  if (typeof description === 'string' && description) out.description = description;
  const postedAt = Date.parse(posting.source_posted_at ?? '');
  if (Number.isFinite(postedAt)) out.postedAt = postedAt;
  const salary = yearlyPay(posting);
  if (salary) out.salary = salary;
  if (typeof posting.source_posting_id === 'string' && posting.source_posting_id) out.externalId = posting.source_posting_id;
  return out;
}

function explain(err) {
  const text = String(err?.message ?? err);
  const code = Object.keys(ERROR_HINTS).find((name) => text.includes(name));
  return new Error(code ? `headcountlabs: ${ERROR_HINTS[code]}` : `headcountlabs: ${text}`);
}

function logAllowance(ctx, res) {
  const jobsLeft = res.headers?.get?.('x-data-records-remaining');
  const requestsLeft = res.headers?.get?.('x-data-requests-remaining');
  if (jobsLeft == null && requestsLeft == null) return;
  ctx.log(`headcountlabs: allowance left this month: ${jobsLeft ?? '?'} jobs, ${requestsLeft ?? '?'} requests`);
}

/**
 * One request, mapped to Job[].
 * @param {any} ctx
 * @param {Record<string, unknown>} filters
 * @param {{ maxJobs?: unknown, sinceDays?: unknown }} opts
 */
async function listJobs(ctx, filters, opts) {
  const key = ctx.env?.[KEY_ENV];
  if (!key) throw new Error(`headcountlabs: ${KEY_ENV} is not set. Add it to .env and enable the plugin`);
  const url = buildRequestUrl(filters, opts);

  let res;
  try {
    res = await ctx.fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, timeoutMs: REQUEST_TIMEOUT_MS });
  } catch (err) {
    throw explain(err);
  }
  const body = await res.json();
  if (!Array.isArray(body?.data)) throw new Error('headcountlabs: unexpected API response (no "data" list)');
  logAllowance(ctx, res);
  return body.data.map(toJob).filter(Boolean);
}

async function fetchEntry(entry, ctx) {
  if (!entry?.filters) {
    throw new Error(`headcountlabs: entry "${entry?.name ?? '?'}" needs a "filters" map, for example filters: { company: "Stripe" }`);
  }
  const settings = ctx.settings ?? {};
  return listJobs(ctx, entry.filters, {
    maxJobs: entry.max_jobs ?? settings.max_jobs,
    sinceDays: entry.since_days ?? settings.since_days,
  });
}

async function search(query, ctx) {
  const settings = ctx.settings ?? {};
  const base = settings.search_filters && typeof settings.search_filters === 'object' ? settings.search_filters : {};
  return listJobs(ctx, { ...base, q: query }, { maxJobs: settings.max_jobs, sinceDays: settings.since_days });
}

export default {
  provider: {
    id: 'headcountlabs',
    // Keyed providers run only on an explicit `provider: headcountlabs` entry.
    detect() { return null; },
    fetch: fetchEntry,
  },
  search,
};
