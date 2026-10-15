import {
  API_PAGE_SIZE,
  BASE_URL,
  emitSearch,
  getJson,
  himAcceptsLatam,
  matchesLocation,
  stringFlag,
  toResult,
  withinDays,
  writeError,
  type CommonOpts,
  type Flags,
  type HimEnvelope,
  type HimJob,
} from "../helpers.js"

export const SEARCH_FLAGS = ["country", "worldwide"]

export const HELP = `himalayas-search - search Himalayas (himalayas.app) remote jobs via its public API

USAGE
  bun run src/cli.ts search [-q "<keywords>"] [flags] [--format json|table|plain]
  bun run src/cli.ts detail <company/slug|url> [--format json|plain]

SEARCH FLAGS
  --query, -q <text>     Keywords (title, skills). Without -q (and without --country /
                         --worldwide) the CLI pages the newest-first feed by cursor.
  --country <name|CC>    Jobs hireable from this country, e.g. Mexico or MX (server-side).
  --worldwide            Only jobs with no country restriction (server-side).
  --location, -l <text>  Client-side substring filter on the location text.
  --latam                Keep only jobs open to a Mexico-based candidate (no country
                         restriction, or Mexico listed).
  --jobage <days>        Posted within N days (client-side).
  --page <n>             1-indexed page. Default 1.
  --limit, -n <n>        Results per page (max 100). Default 25.
  --format <fmt>         json (default) | table | plain.

Every Himalayas job is remote; location is the list of countries it can hire from.
Data: ${BASE_URL}/jobs/api (public, no key).
`

/** Search endpoint: fixed 20-per-page, so fetch the API pages covering the requested window. */
async function searchWindow(params: URLSearchParams, page: number, limit: number): Promise<{ jobs: HimJob[]; total: number | null }> {
  const start = (page - 1) * limit
  const end = start + limit
  const first = Math.floor(start / API_PAGE_SIZE) + 1
  const last = Math.ceil(end / API_PAGE_SIZE)
  const collected: HimJob[] = []
  let total: number | null = null
  for (let p = first; p <= last; p++) {
    params.set("page", String(p))
    const env = await getJson<HimEnvelope>(`${BASE_URL}/jobs/api/search?${params}`)
    if (!env) throw new Error("Himalayas search endpoint not found")
    total = env.totalCount ?? total
    collected.push(...(env.jobs ?? []))
    if ((env.jobs ?? []).length === 0) break
  }
  const offset = start - (first - 1) * API_PAGE_SIZE
  return { jobs: collected.slice(offset, offset + limit), total }
}

/** Feed endpoint: cursor pagination (offset is deprecated), so page N follows N-1 cursors. */
async function feedWindow(page: number, limit: number): Promise<{ jobs: HimJob[]; total: number | null }> {
  let cursor: string | null = null
  for (let p = 1; p <= page; p++) {
    const params = new URLSearchParams({ limit: String(limit) })
    if (cursor) params.set("cursor", cursor)
    const env: HimEnvelope | null = await getJson<HimEnvelope>(`${BASE_URL}/jobs/api?${params}`)
    if (!env) throw new Error("Himalayas feed endpoint not found")
    if (p === page) return { jobs: env.jobs ?? [], total: env.totalCount ?? null }
    cursor = env.nextCursor ?? null
    if (!cursor) return { jobs: [], total: env.totalCount ?? null }
  }
  return { jobs: [], total: null }
}

export async function runSearch(opts: CommonOpts, flags: Flags): Promise<number> {
  if (opts.limit > 100) {
    writeError("--limit must be at most 100 for Himalayas", "BAD_ARG")
    return 1
  }
  const country = stringFlag(flags.country)
  const worldwide = flags.worldwide === true || flags.worldwide === "true"
  try {
    let window: { jobs: HimJob[]; total: number | null }
    if (opts.query || country || worldwide) {
      const params = new URLSearchParams()
      if (opts.query) params.set("q", opts.query)
      if (country) params.set("country", country)
      if (worldwide) params.set("worldwide", "true")
      window = await searchWindow(params, opts.page, opts.limit)
    } else {
      window = await feedWindow(opts.page, opts.limit)
    }
    const rows = window.jobs
      .filter((j) => !opts.latam || himAcceptsLatam(j))
      .map(toResult)
      .filter((r) => matchesLocation(r.location, opts.location) && withinDays(r.date, opts.jobage))
    emitSearch(rows, { page: opts.page, total: window.total }, opts.format)
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "SEARCH_FAILED")
    return 1
  }
}
