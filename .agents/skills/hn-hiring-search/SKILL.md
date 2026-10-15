---
name: hn-hiring-search
version: 1.0.0
description: >
  Use this skill to search the monthly Hacker News "Ask HN: Who is hiring?"
  thread - startup and engineering-led companies posting directly, many remote -
  via the official HN Algolia API, or to read one posting in full. Trigger phrases:
  Hacker News jobs, HN who is hiring, startup jobs, YC startup jobs, remote startup
  engineering jobs, look up this HN job post.
context: fork
enabled: true  # set to false to keep this portal installed but have /scrape skip it
allowed-tools: Bash(bun run .agents/skills/hn-hiring-search/cli/src/cli.ts *)
---

# HN Who-is-hiring Search Skill

Search **[Hacker News "Ask HN: Who is hiring?"](https://news.ycombinator.com/submitted?id=whoishiring)**
postings through the official, open HN Algolia API. No authentication, no API key,
zero runtime dependencies. One thread per month; each top-level comment is one
company's posting, usually written by the hiring engineer or founder - a channel
where a short, specific email often beats a portal application.

## Terms and attribution

The HN Algolia and Firebase APIs are official and open. Postings are free text
written by companies: always read the full post (`detail`) before acting, and
apply the way each post says (email, link). Personal use.

## When to use this skill

- Search by keyword (and the portal's own filters) for roles a Mexico-based
  Python / backend / data engineer can take - add `--latam` to drop postings
  restricted to other countries
- Restrict to recent postings with `--jobage <days>`
- Read one posting in full with `detail` before ranking or applying

## Commands

### Search job listings

```bash
bun run .agents/skills/hn-hiring-search/cli/src/cli.ts search [-q "<keywords>"] [flags] [--format json|table|plain]
```

Portal-specific flags and rules:

- `--thread <id|url>` - a specific monthly thread (default: the newest "Who is hiring?",
  never the "Who wants to be hired?" sibling).
- `-q` runs Algolia's text search inside the thread (top-level comments only);
  every term must also appear in the post text.
- `--latam`: parsed location mentions worldwide/anywhere/Americas/LatAm/Mexico, or
  is a bare REMOTE; "US only"/"EU only" are dropped.

### Fetch full job detail

```bash
bun run .agents/skills/hn-hiring-search/cli/src/cli.ts detail <id|url> [--format json|plain]
```

Returns the search fields plus `description` (plain text) and `apply_url`.

## Usage examples

```bash
# Python postings this month
bun run .agents/skills/hn-hiring-search/cli/src/cli.ts search -q python --format table

# Rust postings plausibly open to LatAm
bun run .agents/skills/hn-hiring-search/cli/src/cli.ts search -q rust --latam --format table

# A previous month's thread
bun run .agents/skills/hn-hiring-search/cli/src/cli.ts search -q "data engineer" --thread 49522897 --format table

# Full post
bun run .agents/skills/hn-hiring-search/cli/src/cli.ts detail 50095921 --format plain
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

- `title`, `company`, `location` and `salary` are **parsed** from the free-text first
  line (`Company | Role | Location | REMOTE | $...`); unusual formats yield
  `"Role not stated (see posting)"` or a null company. Trust `detail`, not the parse.
- `id` is the HN comment id; `url` is `https://news.ycombinator.com/item?id=<id>`.
- Results are newest first; `meta.total` is the filtered count.
- Requests send an honest User-Agent and retry 429/5xx with exponential backoff
  plus jitter; an unreachable API fails fast with a clear error.
- Endpoint details: `url-reference.md`. Data: https://hn.algolia.com/api/v1
