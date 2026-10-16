import {
  BASE_URL,
  emitSearch,
  getJson,
  gobAcceptsLatam,
  matchesLocation,
  stringFlag,
  toResult,
  withinDays,
  writeError,
  type CommonOpts,
  type Flags,
  type GobEnvelope,
} from "../helpers.js"

export const SEARCH_FLAGS = ["country", "remote", "category"]

export const HELP = `getonbrd-search - search GetOnBoard (getonbrd.com), the LatAm tech job board, via its public API

USAGE
  bun run src/cli.ts search -q "<keywords>" [flags] [--format json|table|plain]
  bun run src/cli.ts search --category programming --country MX
  bun run src/cli.ts detail <id|url> [--format json|plain]

SEARCH FLAGS
  --query, -q <text>     Keywords (title, skills). At least one of -q, --country,
                         --remote or --category is required by the API.
  --country <CC>         ISO-3166 alpha-2 country code, e.g. MX, CL, CO (server-side).
  --remote               Only remote postings (server-side).
  --category <slug>      Browse a category instead of searching, e.g. programming,
                         data-science-analytics, sysadmin-devops-qa.
  --location, -l <text>  Client-side substring filter on the location text.
  --latam                Keep only postings open to a Mexico/LatAm-based candidate
                         (fully remote, or Mexico listed).
  --jobage <days>        Posted within N days (client-side).
  --page <n>             1-indexed page. Default 1.
  --limit, -n <n>        Results per page (max 100). Default 25.
  --format <fmt>         json (default) | table | plain.

Salaries on GetOnBoard are USD per month. Data: ${BASE_URL}/api/v0 (public, no key).
`

function buildUrl(opts: CommonOpts, flags: Flags): string | null {
  const country = stringFlag(flags.country)
  const category = stringFlag(flags.category)
  const remote = flags.remote === true || flags.remote === "true"
  const p = new URLSearchParams()
  p.set("per_page", String(Math.min(opts.limit, 100)))
  p.set("page", String(opts.page))
  p.set("expand", '["company","tags"]')
  if (country) p.set("country_code", country.toUpperCase())
  if (remote) p.set("remote", "true")
  if (category && !opts.query) return `${BASE_URL}/api/v0/categories/${encodeURIComponent(category)}/jobs?${p}`
  if (opts.query) p.set("query", opts.query)
  if (!opts.query && !country && !remote) return null
  return `${BASE_URL}/api/v0/search/jobs?${p}`
}

export async function runSearch(opts: CommonOpts, flags: Flags): Promise<number> {
  if (opts.limit > 100) {
    writeError("--limit must be at most 100 for GetOnBoard", "BAD_ARG")
    return 1
  }
  const url = buildUrl(opts, flags)
  if (!url) {
    writeError("GetOnBoard requires at least one of -q, --country, --remote or --category", "BAD_ARG")
    return 1
  }
  try {
    const env = await getJson<GobEnvelope>(url)
    if (!env) {
      writeError("GetOnBoard endpoint not found (unknown --category?)", "SEARCH_FAILED")
      return 1
    }
    const jobs = (env.data ?? []).filter(
      (j) => !opts.latam || gobAcceptsLatam(j.attributes),
    )
    const rows = jobs
      .map(toResult)
      .filter((r) => matchesLocation(r.location, opts.location) && withinDays(r.date, opts.jobage))
    const perPage = env.meta?.per_page ?? opts.limit
    const totalPages = env.meta?.total_pages
    emitSearch(rows, { page: opts.page, total: totalPages ? totalPages * perPage : null }, opts.format)
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "SEARCH_FAILED")
    return 1
  }
}
