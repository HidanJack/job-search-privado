---
name: himalayas-search
version: 1.0.0
description: >
  Use this skill to search remote job listings on Himalayas (himalayas.app) via
  its public API - the largest free remote-jobs feed, with each job's list of
  countries it can hire from - or to look up a specific Himalayas posting.
  Trigger phrases: find remote jobs, remote developer jobs hiring from Mexico,
  remote jobs open to LatAm, worldwide remote roles, look up this himalayas job.
context: fork
enabled: true  # set to false to keep this portal installed but have /scrape skip it
allowed-tools: Bash(bun run .agents/skills/himalayas-search/cli/src/cli.ts *)
---

# Himalayas Search Skill

Search remote job listings from **[Himalayas](https://himalayas.app)** through its
public JSON API. No authentication, no API key, zero runtime dependencies. Every
job is remote; its `locationRestrictions` list says which countries it can hire
from, which makes "open to Mexico" filtering reliable.

## Terms and attribution

The API is public. Keep usage personal, link to the Himalayas job `url`, and apply
through the posting's own link. Himalayas' HTML job pages answer bots with 403, so
this skill never touches them - search and detail both use the API.

## When to use this skill

- Search by keyword (and the portal's own filters) for roles a Mexico-based
  Python / backend / data engineer can take - add `--latam` to drop postings
  restricted to other countries
- Restrict to recent postings with `--jobage <days>`
- Read one posting in full with `detail` before ranking or applying

## Commands

### Search job listings

```bash
bun run .agents/skills/himalayas-search/cli/src/cli.ts search [-q "<keywords>"] [flags] [--format json|table|plain]
```

Portal-specific flags and rules:

- `--country <name|CC>` - jobs hireable from this country, e.g. `Mexico` or `MX` (server-side).
- `--worldwide` - only jobs with no country restriction (server-side).
- Without `-q`/`--country`/`--worldwide` the CLI pages the newest-first feed by
  **cursor** (the API's `offset` is deprecated).
- `--limit` max 100 (the search endpoint serves fixed 20-job pages; the CLI fetches
  the pages covering the requested window).
- `--latam`: no country restriction, or Mexico listed.

### Fetch full job detail

```bash
bun run .agents/skills/himalayas-search/cli/src/cli.ts detail <id|url> [--format json|plain]
```

Returns the search fields plus `description` (plain text) and `apply_url`.

## Usage examples

```bash
# Python backend roles hireable from Mexico
bun run .agents/skills/himalayas-search/cli/src/cli.ts search -q "python backend" --country Mexico --format table

# Worldwide data engineering roles
bun run .agents/skills/himalayas-search/cli/src/cli.ts search -q "data engineer" --worldwide --format table

# Newest jobs open to a Mexico-based candidate, last 4 days
bun run .agents/skills/himalayas-search/cli/src/cli.ts search -q rust --latam --jobage 4 --format table

# Full posting
bun run .agents/skills/himalayas-search/cli/src/cli.ts detail niryu/sr-backend-developer-python-data-engineering-gcp --format plain
```

## Output formats

| Format | Best for |
|--------|----------|
| `json` | Default - programmatic use (`/scrape`, `/rank`) |
| `table` | Quick human-readable scanning |
| `plain` | Reading results or a single job's detail |

Search JSON is `{ "meta": { "count", "page"[, "total"] }, "results": [...] }`. Each
result carries `id`, `title`, `company`, `location`, `date`, `url`, plus `remote`,
`salary`, `tags` and `source` - missing values are `null`, never omitted. Search
results do not include descriptions (keeps `/scrape` context lean); use `detail`
for a shortlisted posting. Errors go to **stderr** as `{ "error": "...", "code": "..." }`
with exit code `1`. Unknown flags are rejected (`UNKNOWN_FLAG`), never ignored.

## Common flags (all five LatAm/remote portal CLIs share them)

- `--query, -q <text>` - keywords
- `--location, -l <text>` - client-side substring filter on the location text (accent-insensitive)
- `--latam` - keep only postings open to a Mexico/LatAm-based candidate (portal-specific rule below)
- `--jobage <days>` - posted within N days
- `--page <n>` / `--limit, -n <n>` - pagination (whole numbers >= 1)
- `--format json|table|plain`

## Notes

- `id` is `<company-slug>/<job-slug>` from the job URL; `detail` also accepts the full URL.
- `detail` searches the slug's words and matches the exact job URL (there is no
  per-job API). Expired jobs report `NOT_FOUND`.
- `meta.total` is Himalayas' own match count (capped at 5000 by the search endpoint).
- Salary keeps its period and currency (`USD 119600–194480/year`).
- Requests send an honest User-Agent and retry 429/5xx with exponential backoff
  plus jitter; an unreachable API fails fast with a clear error.
- Endpoint details: `url-reference.md`. Data: https://himalayas.app/jobs/api
