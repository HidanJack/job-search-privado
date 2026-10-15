import { ALGOLIA, emitDetail, getJson, normalizeId, toDetail, writeError, type HnItem } from "../helpers.js"

export async function runDetail(input: string, format: "json" | "plain"): Promise<number> {
  const id = normalizeId(input)
  if (!id) {
    writeError(`could not parse an HN item id from "${input}"`, "BAD_ID")
    return 1
  }
  try {
    const item = await getJson<HnItem>(`${ALGOLIA}/items/${id}`)
    if (item?.type && item.type !== "comment") {
      writeError(`item ${id} is a ${item.type}, not a hiring post (pass a comment id)`, "BAD_ID")
      return 1
    }
    if (!item || !item.text) {
      writeError("posting not found or deleted", "NOT_FOUND")
      return 1
    }
    emitDetail(toDetail({ id: String(item.id), html: item.text, created_at: item.created_at ?? null }), format)
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    return 1
  }
}
