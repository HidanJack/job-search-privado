---
name: getonbrd-search
version: 1.0.0
description: >
  Use this skill to search live tech job listings on GetOnBoard (getonbrd.com),
  the largest Latin American tech job board (Mexico, Chile, Colombia, Peru and
  LatAm-remote roles), via its public API, or to look up a specific GetOnBoard
  posting. Trigger phrases: find tech jobs in Mexico, LatAm developer jobs,
  trabajos de programador, vacantes de desarrollador, empleo remoto LatAm,
  Python/backend/data jobs in Latin America, look up this getonbrd job.
context: fork
enabled: true  # set to false to keep this portal installed but have /scrape skip it
allowed-tools: Bash(bun run .agents/skills/getonbrd-search/cli/src/cli.ts *)
---

# GetOnBoard Search Skill

Search live job listings from **[GetOnBoard](https://www.getonbrd.com)**, the main
Latin American tech job board, through its documented public API for public job
data. No authentication, no API key, zero runtime dependencies. Postings are
mostly in Spanish and include salary ranges (USD per month) far more often than
other boards.

## Terms and attribution

GetOnBoard publishes its API for public job data. Keep usage personal and
low-volume, always link to the posting's `url` on getonbrd.com, and apply
through GetOnBoard itself. The per-job API endpoint requires a key, so `detail`
re-finds a posting through public search instead (see Notes).

## When to use this skill

- Search by keyword (and the portal's own filters) for roles a Mexico-based
  Python / backend / data engineer can take - add `--latam` to drop postings
  restricted to other countries
- Restrict to recent postings with `--jobage <days>`
- Read one posting in full with `detail` before ranking or applying

## Commands

### Search job listings

```bash
bun run .agents/skills/getonbrd-search/cli/src/cli.ts search [-q "<keywords>"] [flags] [--format json|table|plain]
```

Portal-specific flags and rules:

- `--country <CC>` - ISO-3166 alpha-2 code, e.g. `MX` (server-side).
- `--remote` - only remote postings (server-side).
- `--category <slug>` - browse a category instead of searching, e.g. `programming`,
  `data-science-analytics`, `sysadmin-devops-qa`.
- At least one of `-q`, `--country`, `--remote` or `--category` is required by the API.
- `--limit` max 100.
- `--latam`: fully remote, or Mexico among the listed countries. GetOnBoard's
  `remote_local` modality means *remote within the company's own country*, so a
  Chilean remote-local role is excluded.

### Fetch full job detail

```bash
bun run .agents/skills/getonbrd-search/cli/src/cli.ts detail <id|url> [--format json|plain]
```

Returns the search fields plus `description` (plain text) and `apply_url`.

## Usage examples

```bash
# Python roles, quick scan
bun run .agents/skills/getonbrd-search/cli/src/cli.ts search -q python --format table

# Everything in programming open in Mexico
bun run .agents/skills/getonbrd-search/cli/src/cli.ts search --category programming --country MX --format table

# Data engineering open to someone in Mexico, last 7 days
bun run .agents/skills/getonbrd-search/cli/src/cli.ts search -q "data engineer" --latam --jobage 7 --format table

# Full posting (functions, requirements, nice-to-have, benefits, company)
bun run .agents/skills/getonbrd-search/cli/src/cli.ts detail backend-software-engineer-zaelot-remote-fbc2 --format plain
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

- `id` is the GetOnBoard job slug; `detail` also accepts a getonbrd.com job URL.
- `detail` searches the slug's title words and matches the exact id (the
  `/api/v0/jobs/:id` endpoint answers 401 without a key). Closed postings drop out of
  public search and report `NOT_FOUND`.
- `meta.total` is an estimate (`total_pages × per_page`); client-side filters
  (`--latam`, `-l`, `--jobage`) can make `count` smaller than `--limit`.
- Salaries are USD per month as published by GetOnBoard.
- Requests send an honest User-Agent and retry 429/5xx with exponential backoff
  plus jitter; an unreachable API fails fast with a clear error.
- Endpoint details: `url-reference.md`. Data: https://www.getonbrd.com/api/v0
