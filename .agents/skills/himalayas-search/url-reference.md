# Himalayas API reference

Endpoints and fields this skill depends on - update here if the API changes.
Base URL `https://himalayas.app`. Verified live on 2026-10-15.

| Endpoint | Status | Used by |
|----------|--------|---------|
| `GET /jobs/api/search?q=&country=&worldwide=true&page=` | 200 | `search` (with filters), `detail` |
| `GET /jobs/api?limit=&cursor=` | 200 | `search` (no filters, newest first) |
| `GET /companies/{c}/jobs/{slug}` (HTML) | 403 to bots - never used | - |

- Search pages are a fixed 20 jobs; `page` is 1-indexed; `totalCount` is capped at 5000.
- `country` accepts a name (`Mexico`) or ISO code (`MX`); `worldwide=true` keeps
  jobs with no restriction.
- Feed pagination: pass `nextCursor` back as `?cursor=`. `offset` is deprecated
  (API comment, 21/08/2026).

## Response

`{ comments, updatedAt, offset, limit, totalCount, nextCursor?, jobs: [job] }`

Job fields read: `title`, `companyName`, `guid` (job URL; id = `<company>/<slug>`),
`locationRestrictions` (country names; empty = worldwide), `timezoneRestrictions`,
`pubDate` / `expiryDate` (epoch seconds), `minSalary` / `maxSalary` / `currency` /
`salaryPeriod`, `seniority[]`, `categories[]`, `employmentType`, `description`
(full HTML), `excerpt`, `applicationLink`.
