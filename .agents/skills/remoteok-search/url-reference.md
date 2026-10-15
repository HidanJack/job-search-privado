# Remote OK API reference

Endpoints and fields this skill depends on - update here if the API changes.
Base URL `https://remoteok.com`. Verified live on 2026-10-15.

| Endpoint | Status | Used by |
|----------|--------|---------|
| `GET /api` | 200 | `search`, `detail` |
| `GET /api?tags=python,backend` | 200 | `search --tags` / single-word `-q`, `detail` fallback |

- The response is a JSON **array** whose first element is a legal notice
  (`{ last_updated, legal }`), not a job - skip it.
- About 100 newest postings per request; there is no per-job endpoint and `?id=`
  is ignored.
- Terms (from the legal element): link back to the Remote OK URL without
  `nofollow`, mention Remote OK as the source, don't use the logo.

## Job fields read

`id`, `slug`, `date` (ISO) / `epoch`, `company`, `position`, `tags[]`,
`description` (HTML, sometimes double-decoded UTF-8), `location` (often empty),
`salary_min` / `salary_max` (USD/year, 0 = unknown), `url` (Remote OK page),
`apply_url`.
