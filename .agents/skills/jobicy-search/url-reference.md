# Jobicy API reference

Endpoints and fields this skill depends on - update here if the API changes.
Base URL `https://jobicy.com`. Docs: https://jobi.cy/apidocs. Verified live on 2026-10-15.

| Endpoint | Status | Used by |
|----------|--------|---------|
| `GET /api/v2/remote-jobs?count=&tag=&geo=&industry=&cursor=` | 200 | `search`, `detail` |
| `GET /api/v2/remote-jobs?get=locations` | 200 | list of valid `geo` slugs (reference) |

- `count` up to 100. Pagination by `nextCursor` (pass back as `cursor`) while `hasMore`.
- Unknown `geo` -> HTTP 400 `{ success: false, error: "Invalid 'geo' value..." }`.
- `?id=` is not supported (no per-job endpoint).
- Terms (`friendlyNotice`): credit Jobicy with a direct link; application buttons
  must go to the original job `url`.

## Response

`{ apiVersion, friendlyNotice, jobCount, nextCursor, hasMore, appliedFilters, success, jobs: [job] }`

Job fields read: `id`, `url`, `jobSlug`, `jobTitle`, `companyName`, `jobIndustry[]`,
`jobType[]`, `jobGeo` (e.g. `"LATAM,  USA"`), `jobLevel`, `jobExcerpt`,
`jobDescription` (HTML), `pubDate` (ISO), optional `salaryMin` / `salaryMax` /
`salaryCurrency` / `salaryPeriod` (`yearly`, `monthly`, ...).
