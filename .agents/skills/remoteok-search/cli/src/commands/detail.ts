import { BASE_URL, emitDetail, getJson, isJob, normalizeId, slugTags, toDetail, writeError, type RokJob } from "../helpers.js"

// Remote OK has no per-job API. Detail scans the main feed, then feeds for the
// slug's words as tags, and matches the numeric id. Postings older than those
// feeds' windows are reported as NOT_FOUND.
async function findById(id: string, input: string): Promise<RokJob | null> {
  const urls = [`${BASE_URL}/api`, ...slugTags(input).map((t) => `${BASE_URL}/api?${new URLSearchParams({ tags: t })}`)]
  for (const url of urls) {
    const data = await getJson<RokJob[]>(url)
    const hit = (data ?? []).find((j) => isJob(j) && String(j.id) === id)
    if (hit) return hit
  }
  return null
}

export async function runDetail(input: string, format: "json" | "plain"): Promise<number> {
  const id = normalizeId(input)
  if (!id) {
    writeError(`could not parse a Remote OK job id from "${input}"`, "BAD_ID")
    return 1
  }
  try {
    const job = await findById(id, input)
    if (!job) {
      writeError("job not found in the Remote OK API feeds (it only carries recent postings)", "NOT_FOUND")
      return 1
    }
    emitDetail(toDetail(job), format)
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    return 1
  }
}
