// helpers.ts for hn-hiring-search - shared CLI plumbing followed by the portal-specific mapping.
// ---------------------------------------------------------------------------
// Shared CLI plumbing (flag parsing, HTTP with backoff, output rendering, and
// location/recency filters). Each portal skill carries its own copy so the
// CLI stays self-contained with zero runtime dependencies.
// ---------------------------------------------------------------------------

export const PORTAL = "hn-hiring-search"
const UA = "Mozilla/5.0 (compatible; hn-hiring-search-cli/1.0; personal job search)"

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

export interface Flags {
  _: string[]
  [k: string]: string | boolean | string[]
}

const ALIAS: Record<string, string> = { q: "query", l: "location", n: "limit" }

export function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("-")) {
      ;(flags._ as string[]).push(a)
      continue
    }
    const name = a.replace(/^-+/, "")
    const key = ALIAS[name] ?? name
    const next = argv[i + 1]
    let value: string | boolean = true
    if (next !== undefined && !next.startsWith("-")) {
      value = next
      i++
    }
    flags[key] = value
  }
  return flags
}

export type FlagValue = string | boolean | string[] | undefined

export function stringFlag(raw: FlagValue): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined
}

/** Whole numbers >= 1 only; fractions and 0 are rejected instead of truncated. */
export function parseIntFlag(name: string, raw: FlagValue): number | null {
  const val = typeof raw === "string" ? Number(raw.trim()) : NaN
  if (!Number.isInteger(val) || val < 1) {
    writeError(`--${name} must be a whole number of at least 1, got "${String(raw)}"`, "BAD_ARG")
    return null
  }
  return val
}

/** Options every portal's search accepts. Portal-specific flags ride in `flags`. */
export interface CommonOpts {
  query?: string
  location?: string
  jobage: number | null
  page: number
  limit: number
  format: "json" | "table" | "plain"
  latam: boolean
}

export const COMMON_SEARCH_FLAGS = ["query", "location", "jobage", "page", "limit", "format", "latam"]

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * GET a URL and parse JSON. 429/5xx retry with exponential backoff plus jitter;
 * a 404 returns null; any other non-2xx or an unreachable host throws, so an
 * outage fails fast with a clear message instead of hanging the caller.
 */
export async function getJson<T>(url: string, opts: { maxRetries?: number; baseDelay?: number } = {}): Promise<T | null> {
  const maxRetries = opts.maxRetries ?? 5
  let delay = opts.baseDelay ?? 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response
    try {
      res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
      })
    } catch (e) {
      throw new Error(`could not reach ${new URL(url).host} (${e instanceof Error ? e.message : String(e)})`)
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt === maxRetries) throw new Error(`request failed: ${res.status} ${res.statusText}`)
      await sleep(delay + Math.floor(Math.random() * delay))
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (res.status === 404) return null
    if (!res.ok) {
      // Surface the API's own error message when it sends one (e.g. a bad filter value).
      const detail = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown } | null
      const msg = typeof detail?.error === "string" ? detail.error : typeof detail?.message === "string" ? detail.message : ""
      throw new Error(`request failed: ${res.status} ${res.statusText}${msg ? ` - ${msg}` : ""}`)
    }
    const body = (await res.json().catch(() => undefined)) as T | undefined
    if (body === undefined) throw new Error(`${new URL(url).host} returned an unparseable response body`)
    return body
  }
  throw new Error("request failed after retries")
}

function numericEntity(cp: number): string {
  return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, dec) => numericEntity(parseInt(dec, 10)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex) => numericEntity(parseInt(hex, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
}

/** HTML to readable plain text: block tags become line breaks, tags dropped, entities decoded. */
export function cleanHtml(html: string | null | undefined): string | null {
  if (!html) return null
  const withBreaks = html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|li|ul|ol|div|h\d)>/gi, "\n")
    .replace(/<p[^>]*>/gi, "\n")
  const text = decodeEntities(withBreaks.replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n+- /g, "\n- ")
    .trim()
  return text || null
}

/** ISO-8601 from epoch seconds, an ISO string, or null. */
export function toIsoDate(raw: number | string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === "") return null
  const d = typeof raw === "number" ? new Date(raw * 1000) : new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** True when `date` is within the last `days` days (undated postings are kept). */
export function withinDays(date: string | null, days: number | null, now: number = Date.now()): boolean {
  if (!days || !date) return true
  const t = new Date(date).getTime()
  if (Number.isNaN(t)) return true
  return now - t <= days * 86_400_000
}

const LATAM_POSITIVE = [
  "mexico", "méxico", "latam", "latin america", "latinoamérica", "latinoamerica", "americas",
  "south america", "north america", "worldwide", "anywhere", "global", "world",
]
const LATAM_NEGATIVE = [
  "us only", "usa only", "u.s. only", "us-only", "united states only", "us citizens", "eu only",
  "europe only", "uk only", "canada only", "us time zones only",
]

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
}

/**
 * Whether a location string plausibly accepts a candidate based in Mexico/LatAm.
 * Empty or bare "remote" counts as unknown and is kept (a human reads the
 * posting); explicit single-region restrictions elsewhere are dropped.
 */
export function acceptsLatam(location: string | null | undefined): boolean {
  if (!location) return true
  const s = fold(location)
  if (LATAM_NEGATIVE.some((n) => s.includes(fold(n)))) return false
  if (LATAM_POSITIVE.some((p) => s.includes(fold(p)))) return true
  return /^\s*(fully\s+)?remote\s*$/.test(s)
}

/** Case/accent-insensitive substring match of a --location value. */
export function matchesLocation(location: string | null, wanted: string | undefined): boolean {
  if (!wanted) return true
  return !!location && fold(location).includes(fold(wanted))
}

/** All whitespace-separated query terms appear somewhere in the haystack. */
export function matchesQuery(haystack: string, query: string | undefined): boolean {
  if (!query) return true
  const h = fold(haystack)
  return fold(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => h.includes(term))
}

export interface JobResult {
  id: string
  title: string
  company: string | null
  location: string | null
  date: string | null
  url: string
  remote: boolean | null
  salary: string | null
  tags: string[]
  source: string
}

export interface JobDetail extends JobResult {
  description: string | null
  apply_url: string | null
}

function shortDate(date: string | null): string {
  return date ? date.slice(0, 10) : "—"
}

export function renderTable(rows: JobResult[]): string {
  if (rows.length === 0) return "No results."
  const cols: Array<[string, number, (r: JobResult) => string]> = [
    ["ID", Math.max(2, ...rows.map((r) => r.id.length)), (r) => r.id],
    ["TITLE", 38, (r) => r.title],
    ["COMPANY", 22, (r) => r.company ?? "—"],
    ["LOCATION", 22, (r) => r.location ?? "—"],
    ["DATE", 10, (r) => shortDate(r.date)],
  ]
  const line = (cells: string[]) => cells.map((c, i) => c.slice(0, cols[i][1]).padEnd(cols[i][1])).join("  ")
  const header = line(cols.map((c) => c[0]))
  return [header, "-".repeat(header.length), ...rows.map((r) => line(cols.map((c) => c[2](r))))].join("\n")
}

export function renderPlain(rows: JobResult[]): string {
  if (rows.length === 0) return "No results."
  return rows
    .map((r) =>
      [
        r.title,
        `  ${r.company ?? "—"} · ${r.location ?? "—"} · ${shortDate(r.date)}`,
        r.salary ? `  salary: ${r.salary}` : "",
        `  id: ${r.id}`,
        `  ${r.url}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n")
}

/** Print search results in the requested format. */
export function emitSearch(rows: JobResult[], meta: { page: number; total?: number | null }, format: CommonOpts["format"]): void {
  if (format === "table") process.stdout.write(renderTable(rows) + "\n")
  else if (format === "plain") process.stdout.write(renderPlain(rows) + "\n")
  else {
    const m: Record<string, number> = { count: rows.length, page: meta.page }
    if (meta.total !== undefined && meta.total !== null) m.total = meta.total
    process.stdout.write(JSON.stringify({ meta: m, results: rows }, null, 2) + "\n")
  }
}

/** Print one job detail as JSON or readable text. */
export function emitDetail(job: JobDetail, format: "json" | "plain"): void {
  if (format === "plain") {
    const header = [
      job.title,
      `${job.company ?? "—"} · ${job.location ?? "—"}`,
      job.date ? `Posted: ${job.date.slice(0, 10)}` : null,
      job.salary ? `Salary: ${job.salary}` : null,
      job.tags.length ? `Tags: ${job.tags.join(", ")}` : null,
    ].filter((l): l is string => l !== null)
    const footer = [
      `URL: ${job.url}`,
      job.apply_url && job.apply_url !== job.url ? `Apply: ${job.apply_url}` : null,
      `id: ${job.id}`,
    ].filter((l): l is string => l !== null)
    const text = [header.join("\n"), job.description ?? "(no description)", footer.join("\n")].join("\n\n")
    process.stdout.write(text + "\n")
  } else {
    process.stdout.write(JSON.stringify(job, null, 2) + "\n")
  }
}

/** Slice an already-filtered list into the requested 1-indexed page. */
export function paginate<T>(rows: T[], page: number, limit: number): T[] {
  return rows.slice((page - 1) * limit, page * limit)
}

const PERIODS: Record<string, string> = {
  annual: "year", annually: "year", yearly: "year", year: "year",
  monthly: "month", month: "month", hourly: "hour", hour: "hour",
  weekly: "week", week: "week", daily: "day", day: "day",
}

export function formatSalary(min: number | null | undefined, max: number | null | undefined, currency?: string | null, period?: string | null): string | null {
  const lo = min && min > 0 ? min : null
  const hi = max && max > 0 ? max : null
  if (lo === null && hi === null) return null
  const cur = currency ? `${currency} ` : ""
  const unit = period ? PERIODS[period.toLowerCase()] ?? period.toLowerCase() : ""
  const per = unit ? `/${unit}` : ""
  if (lo !== null && hi !== null && lo !== hi) return `${cur}${lo}–${hi}${per}`
  return `${cur}${lo ?? hi}${per}`
}

// ---------------------------------------------------------------------------
// Hacker News "Ask HN: Who is hiring?" - the monthly thread, read through the
// official open APIs (Algolia HN Search). No key. Each top-level comment is
// one company's posting in free text; the first line conventionally reads
// "Company | Role | Location | REMOTE | ...", which this parser decodes.
// ---------------------------------------------------------------------------

export const ALGOLIA = "https://hn.algolia.com/api/v1"
export const HN_ITEM_URL = "https://news.ycombinator.com/item?id="

export interface AlgoliaStoryHit {
  objectID: string
  title?: string
  created_at?: string
  num_comments?: number
}

export interface AlgoliaCommentHit {
  objectID: string
  comment_text?: string | null
  created_at?: string | null
  parent_id?: number | null
  story_id?: number | null
}

export interface HnItem {
  id: number
  type?: string
  text?: string | null
  title?: string | null
  created_at?: string | null
  parent_id?: number | null
  story_id?: number | null
  children?: HnItem[]
}

/** A normalized posting: one top-level comment. */
export interface HnPosting {
  id: string
  html: string
  created_at: string | null
}

export interface ParsedHeader {
  company: string | null
  title: string | null
  location: string | null
  salary: string | null
  remote: boolean
}

const URL_RE = /(https?:\/\/\S+|www\.\S+)/gi
const WORK_MODE_RE = /\b(remote|onsite|on-site|on site|hybrid|in[- ]office|in office|wfh)\b/i
const ROLE_RE =
  /\b(engineers?|engineering|developers?|swe|scientists?|analysts?|architects?|managers?|designers?|lead|sre|devops|programmers?|founding|cto|head of|interns?|researchers?|consultants?|roles?|positions?|staff|principal|full[- ]?stack|backend|back-end|frontend|front-end)\b/i
const GEO_RE =
  /\b(usa?|u\.s\.|uk|eu|europe|emea|apac|latam|canada|mexico|worldwide|anywhere|global|nyc|sf|bay area|london|berlin|toronto|amsterdam|paris|new york|san francisco|seattle|austin|boston|chicago|remote)\b|[A-Z][a-z]+(?: [A-Z][a-z]+)*, ?[A-Z]{2}\b/i
const SALARY_RE = /[$€£]|\b\d{2,3}\s?k\b|\bk€|\b(usd|eur|gbp|salary|equity)\b/i
const JOB_TYPE_RE = /^(full[- ]?time|part[- ]?time|contract(or)?|freelance|intern(ship)?|perm(anent)?|ft|pt)\b/i

/** HTML comment -> plain text, keeping link text and paragraph breaks. */
export function commentText(html: string): string {
  return cleanHtml(html) ?? ""
}

/** The header line: text before the first paragraph break. */
export function firstLine(html: string): string {
  const head = html.split(/<p>/i)[0]
  const plain = decodeEntities(head.replace(/<[^>]+>/g, " "))
  return plain.split("\n")[0].replace(/\s+/g, " ").trim()
}

function cleanCompany(seg: string): string | null {
  const s = seg
    .replace(URL_RE, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return s || null
}

function unwrapParens(s: string): string {
  const m = s.match(/^\((.*)\)$/)
  return m ? m[1].trim() : s
}

/** Decode "Company | Role | Location | REMOTE | $salary" (also "—"-separated). */
export function parseHeader(line: string): ParsedHeader {
  const segs = line
    .split(/\s*\|\s*|\s+[—–]\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const out: ParsedHeader = { company: null, title: null, location: null, salary: null, remote: false }
  if (segs.length === 0) return out
  out.company = cleanCompany(segs[0])
  const locations: string[] = []
  const leftovers: string[] = []
  for (const seg of segs.slice(1)) {
    const bare = unwrapParens(seg.replace(URL_RE, "").trim())
    if (!bare) continue
    if (JOB_TYPE_RE.test(bare) && bare.length < 25) continue
    const role = bare.search(ROLE_RE)
    const mode = bare.search(WORK_MODE_RE)
    if (!out.title && role >= 0 && (mode < 0 || role < mode)) {
      // "Engineering Manager, Data Platform (NYC, Hybrid)": a role that carries
      // its own location in parentheses.
      out.title = bare
      for (const m of bare.matchAll(/\(([^)]*)\)/g)) if (WORK_MODE_RE.test(m[1])) locations.push(m[1].trim())
    } else if (mode >= 0) locations.push(bare)
    else if (SALARY_RE.test(bare) && !out.salary) out.salary = bare
    else if (GEO_RE.test(bare)) locations.push(bare)
    else leftovers.push(bare)
  }
  // "PrairieLearn (Remote US)": a work mode tucked into the company segment.
  const paren = segs[0].match(/\(([^)]*)\)/)
  if (locations.length === 0 && paren && WORK_MODE_RE.test(paren[1])) locations.push(paren[1].trim())
  if (out.company && paren && WORK_MODE_RE.test(paren[1])) out.company = cleanCompany(segs[0].replace(paren[0], ""))
  if (!out.title && leftovers.length) out.title = leftovers[0]
  if (segs.length === 1) {
    // No separators: free prose, so there is no reliable company field.
    out.company = null
  }
  out.location = locations.length ? locations.join(" / ") : null
  out.remote = /\bremote\b/i.test(out.location ?? "") || /\bremote\b/i.test(line)
  return out
}

/** HN posting -> portal contract result (missing values are null, never omitted). */
export function toResult(p: HnPosting): JobResult {
  const line = firstLine(p.html)
  const h = parseHeader(line)
  return {
    id: p.id,
    title: h.title ?? (h.company ? "Role not stated (see posting)" : line.slice(0, 90) || "(untitled)"),
    company: h.company,
    location: h.location,
    date: toIsoDate(p.created_at),
    url: `${HN_ITEM_URL}${p.id}`,
    remote: h.remote,
    salary: h.salary,
    tags: [],
    source: PORTAL,
  }
}

export function toDetail(p: HnPosting): JobDetail {
  return { ...toResult(p), description: commentText(p.html) || null, apply_url: null }
}

/** The newest "Ask HN: Who is hiring?" story id (skips "Who wants to be hired?" etc.). */
export async function latestThreadId(): Promise<string> {
  const p = new URLSearchParams({ tags: "story,author_whoishiring", hitsPerPage: "20" })
  const env = await getJson<{ hits: AlgoliaStoryHit[] }>(`${ALGOLIA}/search_by_date?${p}`)
  const hit = env?.hits?.find((h) => /who is hiring\?/i.test(h.title ?? ""))
  if (!hit) throw new Error("could not find the latest 'Ask HN: Who is hiring?' thread")
  return hit.objectID
}

/** Item id from a bare id or a news.ycombinator.com/item?id=<id> URL. */
export function normalizeId(input: string): string | null {
  const s = input.trim()
  const m = s.match(/[?&]id=(\d+)/) ?? s.match(/^(\d+)$/)
  return m ? m[1] : null
}
