# HN "Who is hiring?" API reference

Endpoints and fields this skill depends on - update here if the API changes.
Official HN Algolia API, base `https://hn.algolia.com/api/v1`. Verified live on 2026-10-15.

| Endpoint | Status | Used by |
|----------|--------|---------|
| `GET /search_by_date?tags=story,author_whoishiring&hitsPerPage=20` | 200 | find the newest thread |
| `GET /search?tags=comment,story_{id}&query=&hitsPerPage=1000` | 200 | `search -q` |
| `GET /items/{id}` | 200 | `search` without `-q` (thread tree), `detail` |

- The `whoishiring` account posts three stories a month; only titles matching
  "Who is hiring?" are threads of job posts (not "Who wants to be hired?").
- Comment search returns nested replies too; keep `parent_id == story id`.
- Postings link to `https://news.ycombinator.com/item?id={id}`.

## Fields read

Search hits: `objectID`, `comment_text` (HTML), `created_at`, `parent_id`, `story_id`.
Items: `id`, `type` (`story` | `comment`), `text` (HTML), `created_at`, `children[]`.

## First-line convention parsed

`Company | Role(s) | Location | REMOTE/ONSITE/HYBRID | Full-time | $salary | URL`
(also `—` separated). Segments are classified by keywords: work mode -> location,
role words -> title, currency/`k` -> salary, URLs and job types dropped.
