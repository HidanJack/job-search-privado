import { emitDetail, fetchPage, normalizeId, slugTag, toDetail, writeError, type JobicyJob } from "../helpers.js"

// Jobicy has no per-job endpoint. Detail first searches the slug's title words
// as a tag, then walks the unfiltered newest-first feed a few pages deep.
const MAX_FEED_PAGES = 5

async function scan(params: URLSearchParams, id: string, maxPages: number): Promise<JobicyJob | null> {
  for (let p = 1; p <= maxPages; p++) {
    const env = await fetchPage(params)
    const hit = (env.jobs ?? []).find((j) => String(j.id) === id)
    if (hit) return hit
    if (!env.hasMore || !env.nextCursor) return null
    params.set("cursor", env.nextCursor)
  }
  return null
}

export async function runDetail(input: string, format: "json" | "plain"): Promise<number> {
  const id = normalizeId(input)
  if (!id) {
    writeError(`could not parse a Jobicy job id from "${input}"`, "BAD_ID")
    return 1
  }
  try {
    const tag = slugTag(input)
    let job: JobicyJob | null = null
    if (tag) job = await scan(new URLSearchParams({ count: "100", tag }), id, 2)
    if (!job) job = await scan(new URLSearchParams({ count: "100" }), id, MAX_FEED_PAGES)
    if (!job) {
      writeError("job not found in the Jobicy feed (pass the full URL so its title can be searched)", "NOT_FOUND")
      return 1
    }
    emitDetail(toDetail(job), format)
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    return 1
  }
}
