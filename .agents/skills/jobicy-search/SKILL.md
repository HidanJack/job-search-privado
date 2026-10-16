---
name: jobicy-search
version: 1.0.0
description: >
  Use this skill to search remote job listings on Jobicy (jobicy.com) via its
  public API, filtered by region (LatAm, Mexico, anywhere...) and industry, or to
  look up a specific Jobicy posting. Trigger phrases: find remote jobs in LatAm,
  remote jobs open to Mexico, remote developer jobs, jobicy, look up this jobicy job.
context: fork
enabled: true  # set to false to keep this portal installed but have /scrape skip it
allowed-tools: Bash(bun run .agents/skills/jobicy-search/cli/src/cli.ts *)
---

# Jobicy Search Skill

Search remote job listings from **[Jobicy](https://jobicy.com)** through its public
JSON API (v2). No authentication, no API key, zero runtime dependencies. Its
server-side `geo` filter has `latam` and `mexico` slugs, which makes it a direct
source of remote roles explicitly open to Mexico.

## ⚠️ Terms: attribution required - personal use only

Jobicy's API notice: **credit Jobicy with a direct link to the source, and send
every application to the original job URL** provided in the feed. Results keep
that `url`; never rewrite it. Personal use only.

## When to use this skill

- Search by keyword (and the portal's own filters) for roles a Mexico-based
  Python / backend / data engineer can take - add `--latam` to drop postings
  restricted to other countries
- Restrict to recent postings with `--jobage <days>`
- Read one posting in full with `detail` before ranking or applying

## Commands

### Search job listings

```bash
bun run .agents/skills/jobicy-search/cli/src/cli.ts search [-q "<keywords>"] [flags] [--format json|table|plain]
```

Portal-specific flags and rules:

- `-q` is sent as Jobicy's `tag` (title/skills search; multi-word works).
- `--geo <slug>` - region slug (server-side): `latam`, `mexico`, `usa`, `anywhere`, ...
  (list: `https://jobicy.com/api/v2/remote-jobs?get=locations`). An unknown slug is
  an error, not an empty result.
- `--industry <slug>` - industry slug (server-side), e.g. `dev`, `data-science`.
- `--page` follows the API's cursors (page N = N-1 cursor hops). `--limit` max 100.
- `--latam`: client-side check on the region text (LATAM/Mexico/Anywhere...).

### Fetch full job detail

```bash
bun run .agents/skills/jobicy-search/cli/src/cli.ts detail <id|url> [--format json|plain]
```

Returns the search fields plus `description` (plain text) and `apply_url`.

## Usage examples

```bash
# Python roles open to LatAm
bun run .agents/skills/jobicy-search/cli/src/cli.ts search -q python --geo latam --format table

# Any dev role open to Mexico
bun run .agents/skills/jobicy-search/cli/src/cli.ts search --geo mexico --industry dev --format table

# Full posting
bun run .agents/skills/jobicy-search/cli/src/cli.ts detail 155325-senior-software-engineer-observability --format plain
```

## Output formats

| Format | Best for |
|--------|----------|
| `json` | Default - programmatic use (`/scrape`, `/rank`) |
| `table` | Quick human-readable scanning |
| `plain` | Reading results or a single job's detail |

Search JSON is `{ "meta": { "count", "page"[, "total"] }, "results": [...] }`. Each
result carries `id`, `title`, `company`, `location`, `date`, `url`, plus `remote`,
`salary` (display string), `salary_min`, `salary_max`, `salary_currency`, `salary_period` (numeric; period is year|month|week|day|hour), `tags` and `source` - missing values are `null`, never omitted. Search
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

- `id` is Jobicy's slug (`<number>-<title-words>`); `detail` accepts the slug, the
  number, or the job URL. It searches the slug's title words, then walks the
  newest-first feed up to 5 pages; a bare number can only use the feed walk.
- The API reports no total, so `meta.total` is omitted.
- Requests send an honest User-Agent and retry 429/5xx with exponential backoff
  plus jitter; an unreachable API fails fast with a clear error.
- Endpoint details: `url-reference.md`. Data: https://jobicy.com/api/v2/remote-jobs
