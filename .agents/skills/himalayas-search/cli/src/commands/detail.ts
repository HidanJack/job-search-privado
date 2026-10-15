import { BASE_URL, emitDetail, getJson, himId, normalizeId, slugWords, toDetail, writeError, type HimEnvelope, type HimJob } from "../helpers.js"

// Himalayas has no public per-job API and its job pages answer bots with 403,
// but search results carry the full description. So detail searches for the
// slug's words and picks the job whose URL matches the id exactly.
const TERM_COUNTS = [6, 4, 3, 2]
const MAX_PAGES = 3

async function findById(id: string): Promise<HimJob | null> {
  const words = slugWords(id)
  const tried = new Set<string>()
  for (const n of TERM_COUNTS) {
    const q = words.slice(0, n).join(" ")
    if (!q || tried.has(q)) continue
    tried.add(q)
    for (let page = 1; page <= MAX_PAGES; page++) {
      const env = await getJson<HimEnvelope>(`${BASE_URL}/jobs/api/search?${new URLSearchParams({ q, page: String(page) })}`)
      const hit = env?.jobs?.find((j) => himId(j.guid) === id)
      if (hit) return hit
      if (!env || (env.jobs ?? []).length === 0) break
    }
  }
  return null
}

export async function runDetail(input: string, format: "json" | "plain"): Promise<number> {
  const id = normalizeId(input)
  if (!id) {
    writeError(`could not parse a Himalayas job id ("company/slug") from "${input}"`, "BAD_ID")
    return 1
  }
  try {
    const job = await findById(id)
    if (!job) {
      writeError("job not found (expired postings drop out of Himalayas search)", "NOT_FOUND")
      return 1
    }
    emitDetail(toDetail(job), format)
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    return 1
  }
}
