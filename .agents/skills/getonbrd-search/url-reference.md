# GetOnBoard API reference

Endpoints and fields this skill depends on - update here if the API changes.
Base URL `https://www.getonbrd.com`. Docs: https://www.getonbrd.com/api-doc.
Verified live on 2026-10-15.

| Endpoint | Status | Used by |
|----------|--------|---------|
| `GET /api/v0/search/jobs?query=&per_page=&page=&expand=["company"]` | 200 | `search`, `detail` |
| `GET /api/v0/categories/{category}/jobs?per_page=&page=&country_code=` | 200 | `search --category` |
| `GET /api/v0/jobs/{id}` | 401 (needs an API key - not used) | - |

`search/jobs` requires at least one of `query`, `companies`, `featured`, `remote`,
`country_code`, `board_host` (otherwise 422 `unprocessable_content`).
Optional filters: `country_code=MX`, `remote=true`. `per_page` max 100.

## Response (JSON:API)

`{ "data": [job], "meta": { "page", "per_page", "total_pages" } }`

Job fields read: `id` (slug), `links.public_url`, `attributes.title`,
`attributes.company.data.attributes.name` (needs `expand=["company"]`),
`attributes.countries` (e.g. `["Mexico"]`, `["Remote"]`), `attributes.remote`,
`attributes.remote_modality` (`fully_remote` | `remote_local` | `hybrid` | `no_remote`),
`attributes.published_at` (epoch seconds), `attributes.min_salary` / `max_salary`
(USD per month), `attributes.category_name`, and the HTML sections
`functions`, `description`, `desirable`, `benefits`, `projects` with their `*_headline`.
