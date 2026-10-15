import {
  BASE_URL,
  acceptsLatam,
  emitSearch,
  fetchPage,
  matchesLocation,
  stringFlag,
  toResult,
  withinDays,
  writeError,
  type CommonOpts,
  type Flags,
  type JobicyJob,
} from "../helpers.js"

export const SEARCH_FLAGS = ["geo", "industry"]

export const HELP = `jobicy-search - search Jobicy (jobicy.com) remote jobs via its public API

USAGE
  bun run src/cli.ts search [-q "<keywords>"] [--geo latam] [flags]
  bun run src/cli.ts detail <id|url> [--format json|plain]

SEARCH FLAGS
  --query, -q <text>     Keywords, sent as Jobicy's "tag" (title/skills search).
  --geo <slug>           Region slug (server-side), e.g. latam, mexico, usa, anywhere.
                         Full list: ${BASE_URL}/api/v2/remote-jobs?get=locations
  --industry <slug>      Industry slug (server-side), e.g. dev, data-science.
  --location, -l <text>  Client-side substring filter on the location text.
  --latam                Keep only jobs whose region accepts a Mexico/LatAm candidate.
  --jobage <days>        Posted within N days (client-side).
  --page <n>             1-indexed page (follows the API's cursors). Default 1.
  --limit, -n <n>        Results per page (max 100). Default 25.
  --format <fmt>         json (default) | table | plain.

Terms: credit Jobicy with a direct link and send applications to the original
job URL. Data: ${BASE_URL}/api/v2/remote-jobs (public, no key).
`

async function window(params: URLSearchParams, page: number): Promise<{ jobs: JobicyJob[]; total: number | null }> {
  for (let p = 1; p <= page; p++) {
    const env = await fetchPage(params)
    if (p === page) return { jobs: env.jobs ?? [], total: null }
    if (!env.hasMore || !env.nextCursor) return { jobs: [], total: null }
    params.set("cursor", env.nextCursor)
  }
  return { jobs: [], total: null }
}

export async function runSearch(opts: CommonOpts, flags: Flags): Promise<number> {
  if (opts.limit > 100) {
    writeError("--limit must be at most 100 for Jobicy", "BAD_ARG")
    return 1
  }
  const params = new URLSearchParams({ count: String(opts.limit) })
  if (opts.query) params.set("tag", opts.query)
  const geo = stringFlag(flags.geo)
  const industry = stringFlag(flags.industry)
  if (geo) params.set("geo", geo.toLowerCase())
  if (industry) params.set("industry", industry.toLowerCase())
  try {
    const { jobs, total } = await window(params, opts.page)
    const rows = jobs
      .map(toResult)
      .filter(
        (r) =>
          (!opts.latam || acceptsLatam(r.location)) &&
          matchesLocation(r.location, opts.location) &&
          withinDays(r.date, opts.jobage),
      )
    emitSearch(rows, { page: opts.page, total }, opts.format)
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "SEARCH_FAILED")
    return 1
  }
}
