---
name: career-ops-plugin-headcountlabs
description: How to search jobs with the headcountlabs plugin and read the jobs it returns.
license: MIT
---

# headcountlabs

> This file teaches an AI agent how to drive this plugin. It stays inside the
> plugin's own domain: it does not ask the agent to edit core files, change
> scoring, reveal secrets, or act outside the plugin's two hooks.

## What it does

It searches the Headcount Labs jobs API, a catalog of postings collected from
ATS boards and company career sites. It needs `HEADCOUNTLABS_API_KEY` in `.env`.

## How to run it

- Saved searches run during `node scan.mjs`, one per `portals.yml` entry that
  sets `provider: headcountlabs`.
- A one-off query: `node plugins.mjs run headcountlabs search "<words>"`. Add
  `--dry-run` to list results without writing the pipeline.

## portals.yml entry

```yaml
job_boards:
  - name: "Data engineering, Canada"
    provider: headcountlabs
    filters:
      title_advanced: 'data AND engineer'
      country: CA
    max_jobs: 25      # optional, ceiling 250
    since_days: 2     # optional, 0 = no window
```

Filters: `q`, `title`, `title_advanced`, `description_advanced`, `company`,
`location`, `city`, `state`, `country`, `msa`, `work_arrangement`,
`employment_type`, `source`, `exclude_source`, `pay_min`, `pay_currency`,
`has_pay`. One of `q`, `title`, `title_advanced`, `description_advanced` or
`company` is required.

- `title` matches the words as one phrase in that order. `title_advanced`
  matches words in any order and takes `AND`, `OR`, `NOT`, parentheses and
  quoted phrases. Prefer `title_advanced`.
- `country` is a two-letter code. `state` is a two-letter US state unless
  `country` names another country.
- `work_arrangement` is `remote`, `hybrid` or `in_person`.

## What it produces

Each result is a `Job`:

| Field | Source |
| --- | --- |
| `title` | The job title. |
| `url` | The original posting on the employer's board. A posting the source still lists is preferred. |
| `company` | The employer name, or `""` when the source gave none. |
| `location` | Up to three places as `City, State, Country`, with `(Remote)` when the job is remote. |
| `description` | The posting text, when the API returned it. |
| `postedAt` | The employer's posted date, when the source gave one. |
| `salary` | Yearly pay, only when the posting published a yearly figure. |
| `externalId` | The source's own id for the posting. |

Jobs with no title or no http(s) link are dropped.

## Allowance

Each entry costs one API request per scan and each returned job counts as one
job against the user's monthly allowance. Before adding entries or raising
`max_jobs` or `since_days`, tell the user how many requests and jobs a scan
will use. The plugin logs the allowance left after every request. If the API
refuses a request because the allowance is used up, report that to the user
and do not retry in a loop.

## Settings

Defaults in `config/plugins.yml` under `plugins.headcountlabs`: `max_jobs`,
`since_days`, and `search_filters` (filters added to every search query).
