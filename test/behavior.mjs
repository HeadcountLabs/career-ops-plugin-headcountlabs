// Zero-network behavior test: drives both hooks the way career-ops does, with a
// recorded API page standing in for the network.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import hooks, { buildRequestUrl, toJob } from '../index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = JSON.parse(readFileSync(path.join(here, 'fixtures', 'jobs-page.json'), 'utf8'));
const NOW = Date.parse('2026-10-11T12:00:00.000Z');

function fakeCtx({ body = page, failWith = null, settings = {}, env = { HEADCOUNTLABS_API_KEY: 'test-key' } } = {}) {
  const calls = [];
  const logs = [];
  return {
    calls,
    logs,
    env,
    settings,
    log: (...args) => logs.push(args.join(' ')),
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      if (failWith) throw Object.assign(new Error(failWith.message), { status: failWith.status });
      return {
        headers: new Headers({ 'X-Data-Records-Remaining': '975', 'X-Data-Requests-Remaining': '249' }),
        json: async () => body,
      };
    },
  };
}

// Provider: a portals.yml entry becomes exactly one authenticated request.
{
  const ctx = fakeCtx();
  const jobs = await hooks.provider.fetch(
    { name: 'Platform roles', provider: 'headcountlabs', filters: { title_advanced: 'platform AND engineer', country: 'US', work_arrangement: 'remote', pay_min: 150000, has_pay: true }, max_jobs: 40, since_days: 0 },
    ctx,
  );
  assert.strictEqual(ctx.calls.length, 1);
  assert.strictEqual(
    ctx.calls[0].url,
    'https://api.headcountlabs.com/v1/jobs?title_advanced=platform+AND+engineer&country=US&work_arrangement=remote&pay_min=150000&has_pay=true&sort=updated&limit=40',
  );
  assert.strictEqual(ctx.calls[0].opts.headers.Authorization, 'Bearer test-key');
  assert.deepStrictEqual(jobs, [
    {
      title: 'Site Reliability Engineer L4/L5 - Live Cloud Platform SRE',
      url: 'https://netflix.wd108.myworkdayjobs.com/Netflix/job/USA---Remote/Site-Reliability-Engineer-L4-L5---Live-Cloud-Platform-SRE_AJRT44126',
      company: 'Netflix, Inc.',
      location: 'Los Gatos, US (Remote)',
      description: 'Netflix is one of the leading entertainment services.',
      postedAt: 1733961600000,
      salary: { min: 100000, max: 720000, currency: 'USD' },
      externalId: '/job/USA---Remote/Site-Reliability-Engineer-L4-L5---Live-Cloud-Platform-SRE_AJRT44126',
    },
    {
      title: 'Staff Software Engineer - ISPM Platform (Ruby/Rails)',
      url: 'https://job-boards.greenhouse.io/huntress/jobs/7774957003',
      company: 'Huntress',
      location: 'US (Remote)',
      description: 'Founded in 2015 by former NSA cyber operators, Huntress is a remote-first team.',
      postedAt: 1781792928000,
      externalId: '7774957003',
    },
  ]);
  assert.deepStrictEqual(ctx.logs, ['headcountlabs: allowance left this month: 975 jobs, 249 requests']);
}

// Defaults: 25 jobs, and only jobs that entered the catalog in the last 2 days.
assert.strictEqual(
  buildRequestUrl({ company: 'Stripe' }, { now: NOW }),
  'https://api.headcountlabs.com/v1/jobs?company=Stripe&curated_since=2026-10-09T12%3A00%3A00.000Z&sort=updated&limit=25',
);
// max_jobs never exceeds one API page.
assert.strictEqual(
  buildRequestUrl({ q: 'nurse' }, { maxJobs: 9000, sinceDays: 0 }),
  'https://api.headcountlabs.com/v1/jobs?q=nurse&sort=updated&limit=250',
);

// Search: the query plus the saved filters and settings.
{
  const ctx = fakeCtx({ settings: { max_jobs: 5, since_days: 0, search_filters: { country: 'CA' } } });
  const jobs = await hooks.search('staff data engineer', ctx);
  assert.strictEqual(ctx.calls[0].url, 'https://api.headcountlabs.com/v1/jobs?country=CA&q=staff+data+engineer&sort=updated&limit=5');
  assert.strictEqual(jobs.length, 2);
}

// Config mistakes fail before any request is made.
{
  const ctx = fakeCtx();
  await assert.rejects(() => hooks.provider.fetch({ name: 'x' }, ctx), /needs a "filters" map/);
  await assert.rejects(() => hooks.provider.fetch({ name: 'x', filters: { country: 'US' } }, ctx), /set at least one of q, title, title_advanced, description_advanced, company/);
  await assert.rejects(() => hooks.provider.fetch({ name: 'x', filters: { company: 'Stripe', salary: 1 } }, ctx), /unknown filter salary/);
  await assert.rejects(() => hooks.provider.fetch({ name: 'x', filters: { company: 'Stripe', has_pay: 'yes' } }, ctx), /"has_pay" must be true or false/);
  await assert.rejects(() => hooks.provider.fetch({ name: 'x', filters: { company: 'Stripe' }, max_jobs: 0 }, ctx), /max_jobs must be at least 1/);
  assert.strictEqual(ctx.calls.length, 0);
  await assert.rejects(() => hooks.search('x', fakeCtx({ env: {} })), /HEADCOUNTLABS_API_KEY is not set/);
}

// API refusals become one plain sentence.
for (const [status, code, expected] of [
  [401, 'invalid_api_key', /the API key was rejected/],
  [429, 'data_limit_exceeded', /job allowance is used up/],
  [429, 'rate_limited', /the request allowance is used up for now/],
  [504, 'query_timeout', /ran longer than 10 seconds/],
]) {
  const ctx = fakeCtx({ failWith: { status, message: `HTTP ${status}: {"error":{"code":"${code}","message":"m","request_id":"r"}}` } });
  await assert.rejects(() => hooks.search('x', ctx), expected);
}

// A job with no title, or no http(s) link, is dropped.
const [netflix] = page.data;
assert.strictEqual(toJob({ ...netflix, title: { state: 'omitted', value: null } }), null);
const unsafe = { ...netflix.postings[0], posting_url: { state: 'known', value: 'javascript:alert(1)' }, application_url: { state: 'omitted', value: null } };
assert.strictEqual(toJob({ ...netflix, postings: [unsafe] }), null);
// A posting the source no longer lists is used only when no listed one has a link.
const gone = { ...netflix.postings[0], posting_status: 'no_longer_listed', posting_url: { state: 'known', value: 'https://example.com/gone' } };
assert.strictEqual(toJob({ ...netflix, postings: [gone, netflix.postings[0]] }).url, netflix.postings[0].posting_url.value);
// More than three places are summarised.
const place = (city) => ({ state: 'known', value: { city, state: 'TX', country: 'US' } });
assert.strictEqual(
  toJob({ ...netflix, work_arrangement: { state: 'omitted', value: null }, locations: ['Austin', 'Dallas', 'Houston', 'Plano'].map(place) }).location,
  'Austin, TX, US; Dallas, TX, US; Houston, TX, US; +1 more',
);

console.log('✓ behavior ok');
