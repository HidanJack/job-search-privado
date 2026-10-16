---
name: remoteok-search
version: 1.0.0
description: >
  Use this skill to search the newest remote job listings on Remote OK
  (remoteok.com) via its public API, or to look up a specific Remote OK posting.
  Trigger phrases: find remote jobs, remote developer jobs, remote python jobs,
  remote OK, digital nomad jobs, look up this remoteok job.
context: fork
enabled: true  # set to false to keep this portal installed but have /scrape skip it
allowed-tools: Bash(bun run .agents/skills/remoteok-search/cli/src/cli.ts *)
---

# Remote OK Search Skill

Search the newest remote job listings from **[Remote OK](https://remoteok.com)**
through its public JSON API. No authentication, no API key, zero runtime
dependencies. The API is a freshness feed (about the 100 newest postings per tag
set), not an archive - useful for daily scans.

## ⚠️ Terms: attribution required - personal use only

Remote OK's API terms (served inside every response): **link back to the Remote
OK posting URL (followable, no `nofollow`) and mention Remote OK as the source**,
or API access may be suspended; do not use the Remote OK logo. Every result's
`url` is the Remote OK posting URL - keep it in trackers and reports, and credit
"Remote OK" wherever a posting from this skill is shown. Personal use only.

## When to use this skill

- Search by keyword (and the portal's own filters) for roles a Mexico-based
  Python / backend / data engineer can take - add `--latam` to drop postings
  restricted to other countries
- Restrict to recent postings with `--jobage <days>`
- Read one posting in full with `detail` before ranking or applying

## Commands

### Search job listings

```bash
bun run .agents/skills/remoteok-search/cli/src/cli.ts search [-q "<keywords>"] [flags] [--format json|table|plain]
```

Portal-specific flags and rules:

- `--tags <a,b>` - Remote OK tags to fetch (server-side), e.g. `python,backend`.
- A single-word `-q` is also sent as a tag; every query term must then appear in
  the title, company, tags or description (client-side).
- `--latam`: location mentions worldwide/anywhere/Americas/LatAm/Mexico, or is
  unspecified (many Remote OK jobs leave it blank - read the posting).

### Fetch full job detail

```bash
bun run .agents/skills/remoteok-search/cli/src/cli.ts detail <id|url> [--format json|plain]
```

Returns the search fields plus `description` (plain text) and `apply_url`.

## Usage examples

```bash
# Newest Python jobs
bun run .agents/skills/remoteok-search/cli/src/cli.ts search -q python --format table

# Backend + Python tags, open to LatAm
bun run .agents/skills/remoteok-search/cli/src/cli.ts search --tags python,backend --latam --format table

# Full posting
bun run .agents/skills/remoteok-search/cli/src/cli.ts detail https://remoteok.com/remote-jobs/remote-principal-software-engineer-vytalize-health-1137508 --format plain
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

- `id` is Remote OK's numeric id; `detail` accepts the id, the slug, or the URL.
- `detail` scans the main feed and the feeds for the slug's words as tags; older
  postings outside those windows report `NOT_FOUND`.
- Some upstream text arrives double-decoded (`Â`, `Ã©`); the CLI repairs it.
- `meta.total` is the filtered count; pagination happens after filtering.
- Requests send an honest User-Agent and retry 429/5xx with exponential backoff
  plus jitter; an unreachable API fails fast with a clear error.
- Endpoint details: `url-reference.md`. Data: https://remoteok.com/api
