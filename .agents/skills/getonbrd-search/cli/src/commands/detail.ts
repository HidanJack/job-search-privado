import { BASE_URL, emitDetail, getJson, normalizeId, slugQuery, toDetail, writeError, type GobEnvelope, type GobJob } from "../helpers.js"

// GetOnBoard's per-job endpoint (/api/v0/jobs/:id) requires an API key, but its
// public search returns every field the detail view needs. So detail recovers
// the title words from the slug, searches for them, and picks the exact id.
const TERM_COUNTS = [6, 4, 3, 2]
const MAX_PAGES = 3

async function findById(id: string): Promise<GobJob | null> {
  const words = slugQuery(id).split(" ")
  const tried = new Set<string>()
  for (const n of TERM_COUNTS) {
    const query = words.slice(0, n).join(" ")
    if (!query || tried.has(query)) continue
    tried.add(query)
    for (let page = 1; page <= MAX_PAGES; page++) {
      const p = new URLSearchParams({ query, per_page: "100", page: String(page), expand: '["company"]' })
      const env = await getJson<GobEnvelope>(`${BASE_URL}/api/v0/search/jobs?${p}`)
      const hit = env?.data?.find((j) => j.id === id)
      if (hit) return hit
      if (!env || page >= (env.meta?.total_pages ?? 1)) break
    }
  }
  return null
}

export async function runDetail(input: string, format: "json" | "plain"): Promise<number> {
  const id = normalizeId(input)
  if (!id) {
    writeError(`could not parse a GetOnBoard job id from "${input}"`, "BAD_ID")
    return 1
  }
  try {
    const job = await findById(id)
    if (!job) {
      writeError("job not found (closed postings drop out of GetOnBoard's public search)", "NOT_FOUND")
      return 1
    }
    emitDetail(toDetail(job), format)
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    return 1
  }
}
