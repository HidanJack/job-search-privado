import {
  BASE_URL,
  acceptsLatam,
  emitSearch,
  getJson,
  isJob,
  matchesLocation,
  matchesQuery,
  paginate,
  searchText,
  stringFlag,
  toResult,
  withinDays,
  writeError,
  type CommonOpts,
  type Flags,
  type RokJob,
} from "../helpers.js"

export const SEARCH_FLAGS = ["tags"]

export const HELP = `remoteok-search - search Remote OK (remoteok.com) remote jobs via its public API

USAGE
  bun run src/cli.ts search [-q "<keywords>"] [--tags python,backend] [flags]
  bun run src/cli.ts detail <id|slug|url> [--format json|plain]

SEARCH FLAGS
  --query, -q <text>     Keywords; every term must appear in title, company, tags or
                         description (client-side). Single words are also sent as tags.
  --tags <a,b>           Remote OK tags to fetch (server-side), e.g. python,backend.
  --location, -l <text>  Client-side substring filter on the location text.
  --latam                Keep only jobs whose location plausibly accepts a Mexico/LatAm
                         candidate (worldwide/anywhere/LatAm/Mexico, or unspecified).
  --jobage <days>        Posted within N days (client-side).
  --page <n>             1-indexed page over the filtered list. Default 1.
  --limit, -n <n>        Results per page. Default 25.
  --format <fmt>         json (default) | table | plain.

The API returns the newest postings for the requested tags (about 100), so this
is a freshness feed, not an archive. Terms: link back to the Remote OK posting
URL and credit Remote OK as the source. Data: ${BASE_URL}/api (public, no key).
`

function tagsFor(opts: CommonOpts, flags: Flags): string | null {
  const explicit = stringFlag(flags.tags)
  if (explicit) return explicit
  if (!opts.query) return null
  const words = opts.query.split(/\s+/).filter(Boolean)
  return words.length === 1 ? words[0].toLowerCase() : null
}

export async function runSearch(opts: CommonOpts, flags: Flags): Promise<number> {
  const tags = tagsFor(opts, flags)
  const url = tags ? `${BASE_URL}/api?${new URLSearchParams({ tags })}` : `${BASE_URL}/api`
  try {
    const data = await getJson<RokJob[]>(url)
    if (!data || !Array.isArray(data)) {
      writeError("Remote OK API returned no job list", "SEARCH_FAILED")
      return 1
    }
    const matched = data
      .filter(isJob)
      .filter((j) => matchesQuery(searchText(j), opts.query))
      .map(toResult)
      .filter(
        (r) =>
          (!opts.latam || acceptsLatam(r.location)) &&
          matchesLocation(r.location, opts.location) &&
          withinDays(r.date, opts.jobage),
      )
    emitSearch(paginate(matched, opts.page, opts.limit), { page: opts.page, total: matched.length }, opts.format)
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "SEARCH_FAILED")
    return 1
  }
}
