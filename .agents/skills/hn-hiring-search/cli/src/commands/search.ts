import {
  ALGOLIA,
  acceptsLatam,
  commentText,
  emitSearch,
  getJson,
  latestThreadId,
  matchesLocation,
  matchesQuery,
  normalizeId,
  paginate,
  stringFlag,
  toResult,
  withinDays,
  writeError,
  type AlgoliaCommentHit,
  type CommonOpts,
  type Flags,
  type HnItem,
  type HnPosting,
} from "../helpers.js"

export const SEARCH_FLAGS = ["thread"]

export const HELP = `hn-hiring-search - search Hacker News "Ask HN: Who is hiring?" postings via the official HN Algolia API

USAGE
  bun run src/cli.ts search [-q "<keywords>"] [--latam] [flags]
  bun run src/cli.ts detail <comment-id|url> [--format json|plain]

SEARCH FLAGS
  --query, -q <text>     Keywords; every term must appear in the posting text.
  --thread <id|url>      A specific monthly thread. Default: the newest one.
  --location, -l <text>  Client-side substring filter on the parsed location.
  --latam                Keep postings whose location plausibly accepts a Mexico/LatAm
                         candidate (worldwide/anywhere/Americas/LatAm, or bare REMOTE).
  --jobage <days>        Posted within N days.
  --page <n>             1-indexed page over the filtered list. Default 1.
  --limit, -n <n>        Results per page. Default 25.
  --format <fmt>         json (default) | table | plain.

One thread per month; each top-level comment is one company's posting. Title,
company and location are parsed from the free-text first line and can be
imperfect - read the posting (detail) before trusting them.
Data: ${ALGOLIA} (official, open, no key).
`

async function postingsFor(threadId: string, query: string | undefined): Promise<HnPosting[]> {
  if (query) {
    // Server-side text search inside the thread; keep top-level comments only.
    const p = new URLSearchParams({ tags: `comment,story_${threadId}`, query, hitsPerPage: "1000" })
    const env = await getJson<{ hits: AlgoliaCommentHit[] }>(`${ALGOLIA}/search?${p}`)
    return (env?.hits ?? [])
      .filter((h) => String(h.parent_id) === threadId && h.comment_text)
      .map((h) => ({ id: h.objectID, html: h.comment_text as string, created_at: h.created_at ?? null }))
  }
  const item = await getJson<HnItem>(`${ALGOLIA}/items/${threadId}`)
  if (!item) throw new Error(`thread ${threadId} not found`)
  return (item.children ?? [])
    .filter((c) => c.text)
    .map((c) => ({ id: String(c.id), html: c.text as string, created_at: c.created_at ?? null }))
}

export async function runSearch(opts: CommonOpts, flags: Flags): Promise<number> {
  const threadFlag = stringFlag(flags.thread)
  const threadId = threadFlag ? normalizeId(threadFlag) : null
  if (threadFlag && !threadId) {
    writeError(`could not parse a thread id from "${threadFlag}"`, "BAD_ARG")
    return 1
  }
  try {
    const id = threadId ?? (await latestThreadId())
    const postings = await postingsFor(id, opts.query)
    const rows = postings
      .filter((p) => matchesQuery(commentText(p.html), opts.query))
      .map(toResult)
      .filter(
        (r) =>
          (!opts.latam || acceptsLatam(r.location)) &&
          matchesLocation(r.location, opts.location) &&
          withinDays(r.date, opts.jobage),
      )
      .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    emitSearch(paginate(rows, opts.page, opts.limit), { page: opts.page, total: rows.length }, opts.format)
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "SEARCH_FAILED")
    return 1
  }
}
