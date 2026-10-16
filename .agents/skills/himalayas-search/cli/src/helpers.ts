// helpers.ts for himalayas-search - shared CLI plumbing followed by the portal-specific mapping.
// ---------------------------------------------------------------------------
// Shared CLI plumbing (flag parsing, HTTP with backoff, output rendering, and
// location/recency filters). Each portal skill carries its own copy so the
// CLI stays self-contained with zero runtime dependencies.
// ---------------------------------------------------------------------------

export const PORTAL = "himalayas-search"
const UA = "Mozilla/5.0 (compatible; himalayas-search-cli/1.0; personal job search)"

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
  salary_min: number | null
  salary_max: number | null
  salary_currency: string | null
  salary_period: string | null
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

/** Numeric salary fields (null when absent; never omitted). Period is normalised to year|month|week|day|hour. */
export function formatSalaryFields(
  min: number | null | undefined,
  max: number | null | undefined,
  currency?: string | null,
  period?: string | null,
): { salary_min: number | null; salary_max: number | null; salary_currency: string | null; salary_period: string | null } {
  const lo = typeof min === "number" && min > 0 ? min : null
  const hi = typeof max === "number" && max > 0 ? max : null
  if (lo === null && hi === null) return { salary_min: null, salary_max: null, salary_currency: null, salary_period: null }
  const p = period ? period.toLowerCase() : null
  return {
    salary_min: lo ?? hi,
    salary_max: hi ?? lo,
    salary_currency: currency ? currency.toUpperCase() : null,
    salary_period: p ? PERIODS[p] ?? p : null,
  }
}

// ---------------------------------------------------------------------------
// Himalayas (himalayas.app) - public remote-jobs JSON API, no key.
// ---------------------------------------------------------------------------

export const BASE_URL = "https://himalayas.app"
export const API_PAGE_SIZE = 20

export interface HimJob {
  title: string
  excerpt?: string | null
  companyName?: string | null
  companySlug?: string | null
  employmentType?: string | null
  minSalary?: number | null
  maxSalary?: number | null
  salaryPeriod?: string | null
  currency?: string | null
  seniority?: string[]
  locationRestrictions?: string[]
  timezoneRestrictions?: number[]
  categories?: string[]
  description?: string | null
  pubDate?: number | null
  expiryDate?: number | null
  applicationLink?: string | null
  guid: string
}

export interface HimEnvelope {
  totalCount?: number
  offset?: number
  limit?: number
  nextCursor?: string | null
  jobs: HimJob[]
}

/** "<company>/<job-slug>" from a Himalayas job URL (the guid), or null. */
export function himId(guid: string): string | null {
  const m = guid.match(/\/companies\/([^/]+)\/jobs\/([^/?#]+)/)
  return m ? `${m[1]}/${m[2]}` : null
}

/** Accept "<company>/<slug>" or a full himalayas.app/companies/<c>/jobs/<s> URL. */
export function normalizeId(input: string): string | null {
  const s = input.trim()
  if (/^https?:\/\//i.test(s)) return himId(s)
  return /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/i.test(s) ? s : null
}

export function himLocation(j: HimJob): string {
  const r = (j.locationRestrictions ?? []).filter(Boolean)
  return r.length ? `Remote (${r.join(", ")})` : "Remote (worldwide)"
}

/** Open to a Mexico-based candidate: no country restriction, or Mexico listed. */
export function himAcceptsLatam(j: HimJob): boolean {
  const r = j.locationRestrictions ?? []
  return r.length === 0 || r.some((c) => /m[eé]xico/i.test(c))
}

/** Himalayas job -> portal contract result (missing values are null, never omitted). */
export function toResult(j: HimJob): JobResult {
  return {
    id: himId(j.guid) ?? j.guid,
    title: decodeEntities(j.title ?? "").trim() || "(untitled)",
    company: j.companyName?.trim() || null,
    location: himLocation(j),
    date: toIsoDate(j.pubDate ?? null),
    url: j.guid,
    remote: true,
    salary: formatSalary(j.minSalary, j.maxSalary, j.currency, j.salaryPeriod),
    ...formatSalaryFields(j.minSalary, j.maxSalary, j.currency, j.salaryPeriod),
    tags: [...(j.seniority ?? []), ...(j.categories ?? []).slice(0, 5).map((c) => c.replace(/-/g, " "))],
    source: PORTAL,
  }
}

export function toDetail(j: HimJob): JobDetail {
  const extra = [
    j.employmentType ? `Employment: ${j.employmentType}` : null,
    j.timezoneRestrictions?.length ? `Timezones (UTC offsets): ${j.timezoneRestrictions.join(", ")}` : null,
    j.expiryDate ? `Expires: ${toIsoDate(j.expiryDate)?.slice(0, 10)}` : null,
  ].filter((l): l is string => l !== null)
  const body = cleanHtml(j.description) ?? j.excerpt ?? null
  return {
    ...toResult(j),
    description: body && extra.length ? `${extra.join("\n")}\n\n${body}` : body,
    apply_url: j.applicationLink ?? null,
  }
}

/** Search words recovered from a job slug ("senior-python-engineer" -> "senior python engineer"). */
export function slugWords(id: string): string[] {
  const slug = id.split("/").pop() ?? id
  return slug.split("-").filter((w) => w && !/^\d+$/.test(w))
}
