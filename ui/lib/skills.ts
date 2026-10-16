import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Salary sampler for the "Cuánto pagan tus habilidades" section. It runs the
// portal CLIs (never Claude), keeps only postings relevant to the skill (see
// isRelevant), converts pay to MXN per month and aggregates percentiles per group.

export type Group = "mx" | "latam_local" | "remote_intl";
export const GROUPS: Group[] = ["mx", "latam_local", "remote_intl"];
export const MIN_SAMPLE = 8;
export const NOISE_LOW = 8_000;
export const NOISE_HIGH = 600_000;
export const STALE_DAYS = 15;
export const PAGE_SIZE = 100;
export const PAUSE_MS = 700;

export const DEFAULT_FX: Record<string, number> = { USD: 18.5, EUR: 20, GBP: 23.5, CAD: 13.5, MXN: 1 };

// ---------------------------------------------------------------------------
// Skills (query terms + relevance matcher over title/tags/category)
// ---------------------------------------------------------------------------

export interface SkillDef {
  id: string;
  label: string;
  queries: string[];
  /** OR of AND-groups; every term is a regex source matched case-insensitively. */
  match: string[][];
}

export const SKILLS: SkillDef[] = [
  { id: "rust", label: "Rust", queries: ["rust"], match: [["\\brust\\b"]] },
  { id: "rust_python", label: "Rust + Python (PyO3)", queries: ["rust python"], match: [["\\brust\\b", "\\bpython\\b"], ["pyo3"]] },
  { id: "python", label: "Python", queries: ["python"], match: [["\\bpython\\b"]] },
  { id: "kubernetes", label: "Kubernetes", queries: ["kubernetes"], match: [["\\bkubernetes\\b"], ["\\bk8s\\b"]] },
  { id: "ocr", label: "OCR", queries: ["ocr"], match: [["\\bocr\\b"], ["optical character"], ["document (ai|intelligence|processing)"]] },
  { id: "llm", label: "LLM", queries: ["llm"], match: [["\\bllms?\\b"], ["large language model"], ["generative ai|\\bgenai\\b"], ["langchain|openai"]] },
  { id: "rag", label: "RAG", queries: ["rag"], match: [["\\brag\\b"], ["retrieval[- ]augmented"]] },
  { id: "ai_engineer", label: "AI Engineer", queries: ["ai engineer"], match: [["\\bai engineer"], ["\\b(machine learning|ml) engineer"], ["\\bai\\s*/\\s*ml\\b"], ["artificial intelligence engineer"]] },
  { id: "data_engineer", label: "Data Engineer", queries: ["data engineer"], match: [["data engineer"], ["ingenier[oa] de datos"], ["analytics engineer"]] },
  { id: "etl", label: "ETL", queries: ["etl"], match: [["\\betl\\b"], ["\\belt\\b"], ["data pipelines?"]] },
  { id: "fastapi", label: "FastAPI", queries: ["fastapi"], match: [["fastapi"]] },
  { id: "react_native", label: "React Native", queries: ["react native"], match: [["react[- ]native"]] },
  { id: "fintech", label: "Fintech", queries: ["fintech"], match: [["fintech"], ["financial technology"], ["neobank|digital bank"], ["\\bpayments?\\b"], ["\\blending\\b"]] },
  { id: "cfdi", label: "CFDI / facturación", queries: ["cfdi"], match: [["cfdi"], ["facturaci[oó]n electr[oó]nica"], ["timbrado"]] },
  { id: "contable", label: "Contable / accounting", queries: ["accounting", "contable"], match: [["accounting|accountant"], ["contab"], ["bookkeep"]] },
  { id: "astro", label: "Astro", queries: ["astro"], match: [["\\bastro(\\.?js)?\\b"]] },
  { id: "landing_page", label: "Landing page", queries: ["landing page"], match: [["landing[- ]pages?"], ["\\bwebflow\\b"]] },
  { id: "qa_automation", label: "QA automation / Selenium", queries: ["qa automation", "selenium"], match: [["qa automation|test automation|automation (qa|test)"], ["\\bselenium\\b"], ["\\bsdet\\b"]] },
  { id: "neo4j", label: "Neo4j", queries: ["neo4j"], match: [["neo4j"], ["graph database"], ["\\bcypher\\b"]] },
];

/** "Tu combinación": Python AND at least one of these. */
export const COMBO_PARTNERS = ["fintech", "cfdi", "contable", "ocr", "llm", "rag", "rust", "kubernetes"];
export const COMBO_ID = "combo";
export const COMBO_LABEL = "Python + otra de tus especialidades";

const compiled = new Map<string, RegExp[][]>();
function matchers(def: SkillDef): RegExp[][] {
  let m = compiled.get(def.id);
  if (!m) {
    m = def.match.map((all) => all.map((src) => new RegExp(src, "i")));
    compiled.set(def.id, m);
  }
  return m;
}

export function jobText(job: Pick<RawJob, "title" | "tags">): string {
  return `${job.title ?? ""} | ${(job.tags ?? []).join(" | ")}`;
}

/**
 * Relevance rule (strict on every portal): the skill (or a synonym from the
 * table) must appear in the title or the portal's real tags/category. We do NOT
 * trust the portal's query match: getonbrd searches full descriptions, so a
 * passing mention inflated the sample; himalayas' fuzzy search returned ~90%
 * unrelated jobs for Rust/Kubernetes, and its tags are rich enough to keep a
 * usable sample under the strict rule.
 */
export function isRelevant(job: Pick<RawJob, "title" | "tags">, def: SkillDef): boolean {
  const text = jobText(job);
  return matchers(def).some((all) => all.every((re) => re.test(text)));
}

// ---------------------------------------------------------------------------
// Portal plan
// ---------------------------------------------------------------------------

export interface PortalVariant {
  /** Short label stored with each raw job. */
  name: string;
  args: string[];
  /** The CLI already limits results to postings open to a Mexico/LatAm candidate. */
  openToMx: boolean;
  /** Query-per-call is paged (page 2 only when page 1 is full). */
  paged: boolean;
}
export interface PortalPlan {
  portal: string;
  variants: PortalVariant[];
}

export const PORTALS: PortalPlan[] = [
  {
    portal: "getonbrd",
    variants: [
      { name: "all", args: [], openToMx: false, paged: true },
      { name: "latam", args: ["--latam"], openToMx: true, paged: true },
    ],
  },
  {
    portal: "jobicy",
    variants: [
      { name: "geo-latam", args: ["--geo", "latam"], openToMx: true, paged: true },
      { name: "geo-mexico", args: ["--geo", "mexico"], openToMx: true, paged: true },
    ],
  },
  {
    portal: "himalayas",
    variants: [{ name: "country-mexico", args: ["--country", "Mexico"], openToMx: true, paged: true }],
  },
];

export function cliPath(root: string, portal: string): string {
  return join(root, ".agents", "skills", `${portal}-search`, "cli", "src", "cli.ts");
}

export function buildArgv(bun: string, root: string, portal: string, query: string, variant: string[], page: number): string[] {
  return [bun, "run", cliPath(root, portal), "search", "-q", query, "--limit", String(PAGE_SIZE), "--page", String(page), "--format", "json", ...variant];
}

// ---------------------------------------------------------------------------
// Raw jobs
// ---------------------------------------------------------------------------

export interface RawJob {
  key: string;
  portal: string;
  id: string;
  title: string;
  company: string | null;
  location: string | null;
  url: string | null;
  remote: boolean | null;
  tags: string[];
  salary: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_period: string | null;
  /** True when some variant that already filters for Mexico/LatAm returned it. */
  open_to_mx: boolean;
  via: string[];
  /** Queries that returned it (absent in raw files from before this field). */
  queries?: string[];
}

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** Normalises one CLI result row. Returns null when it has neither id nor url. */
export function toRawJob(portal: string, row: unknown, variant: PortalVariant, query?: string): RawJob | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = strOrNull(r.id) ?? (typeof r.id === "number" ? String(r.id) : null);
  const url = strOrNull(r.url);
  const ident = id ?? url;
  if (!ident) return null;
  return {
    key: `${portal}:${ident}`,
    portal,
    id: id ?? ident,
    title: strOrNull(r.title) ?? "",
    company: strOrNull(r.company),
    location: strOrNull(r.location),
    url,
    remote: typeof r.remote === "boolean" ? r.remote : null,
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string") : [],
    salary: strOrNull(r.salary),
    salary_min: numOrNull(r.salary_min),
    salary_max: numOrNull(r.salary_max),
    salary_currency: strOrNull(r.salary_currency),
    salary_period: strOrNull(r.salary_period),
    open_to_mx: variant.openToMx,
    via: [variant.name],
    queries: query ? [query] : [],
  };
}

/** Dedup by portal+id (or url); merges the provenance of repeated sightings. */
export function addJob(into: Map<string, RawJob>, job: RawJob): void {
  const prev = into.get(job.key);
  if (!prev) {
    into.set(job.key, job);
    return;
  }
  prev.open_to_mx ||= job.open_to_mx;
  for (const v of job.via) if (!prev.via.includes(v)) prev.via.push(v);
  const qs = (prev.queries ??= []);
  for (const q of job.queries ?? []) if (!qs.includes(q)) qs.push(q);
}

// ---------------------------------------------------------------------------
// Salary conversion
// ---------------------------------------------------------------------------

export const PERIOD_TO_MONTH: Record<string, number> = {
  year: 1 / 12, month: 1, week: 52 / 12, day: 21, hour: 160,
};
const PERIOD_ALIASES: Record<string, string> = {
  annual: "year", annually: "year", yearly: "year", year: "year", yr: "year",
  monthly: "month", month: "month", mo: "month",
  weekly: "week", week: "week", daily: "day", day: "day", hourly: "hour", hour: "hour", hr: "hour",
};

export function normalizePeriod(p: string | null | undefined): string | null {
  return p ? PERIOD_ALIASES[p.trim().toLowerCase()] ?? null : null;
}

/** Fallback for CLIs that predate the numeric fields: "USD 1000–2000/month". */
export function parseSalaryString(s: string | null): { min: number; max: number; currency: string | null; period: string | null } | null {
  if (!s) return null;
  const m = s.match(/^(?:([A-Z]{3})\s+)?([\d.]+)(?:[–-]([\d.]+))?(?:\/(\w+))?$/);
  if (!m) return null;
  const lo = Number(m[2]);
  const hi = m[3] ? Number(m[3]) : lo;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return { min: lo, max: hi, currency: m[1] ?? null, period: normalizePeriod(m[4]) };
}

export type SalaryOutcome =
  | { ok: true; mxn: number; hourly: boolean }
  | { ok: false; reason: "no_salary" | "unknown_currency" | "no_period" | "noise_low" | "noise_high" };

/** Midpoint of the range, converted to MXN per month. */
export function monthlyMxn(job: RawJob, fx: Record<string, number>): SalaryOutcome {
  let lo = job.salary_min;
  let hi = job.salary_max;
  let currency = job.salary_currency;
  let period = normalizePeriod(job.salary_period);
  if (lo === null && hi === null) {
    const parsed = parseSalaryString(job.salary);
    if (!parsed) return { ok: false, reason: "no_salary" };
    ({ min: lo, max: hi, currency } = parsed);
    period = parsed.period;
  }
  const a = lo ?? hi;
  const b = hi ?? lo;
  if (a === null || b === null || a <= 0 || b <= 0) return { ok: false, reason: "no_salary" };
  const rate = fx[(currency ?? "").toUpperCase()];
  if (!rate) return { ok: false, reason: "unknown_currency" };
  if (!period) return { ok: false, reason: "no_period" };
  const mxn = ((a + b) / 2) * rate * PERIOD_TO_MONTH[period];
  if (mxn < NOISE_LOW) return { ok: false, reason: "noise_low" };
  if (mxn > NOISE_HIGH) return { ok: false, reason: "noise_high" };
  return { ok: true, mxn, hourly: period === "hour" };
}

// ---------------------------------------------------------------------------
// Group classification
// ---------------------------------------------------------------------------

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const MEXICO_RE = /mexico|\bcdmx\b|\bmx\b|guadalajara|monterrey|\bjalisco\b|nuevo leon/;
const LATAM_COUNTRIES = [
  "argentina", "bolivia", "brazil", "brasil", "chile", "colombia", "costa rica", "cuba", "dominican", "ecuador",
  "el salvador", "guatemala", "honduras", "nicaragua", "panama", "paraguay", "peru", "puerto rico", "uruguay", "venezuela",
  "buenos aires", "santiago", "bogota", "medellin", "lima", "sao paulo", "montevideo",
];
const OPEN_RE = /anywhere|worldwide|global|latam|latin|americas|\bany\b/;

/**
 * mx: Mexico is the only Latin American place named. latam_local: only other
 * Latin American places. remote_intl: remote and open to Mexico (anywhere,
 * LatAm-wide, several countries including Mexico, or returned by a Mexico/LatAm
 * filter). null: not usable for any of the three groups.
 */
export function classifyGroup(job: Pick<RawJob, "location" | "open_to_mx">): Group | null {
  const loc = fold(job.location ?? "");
  const hasMx = MEXICO_RE.test(loc);
  const others = new Set<string>();
  for (const c of LATAM_COUNTRIES) if (loc.includes(c)) others.add(c);
  if (hasMx) return others.size === 0 ? "mx" : "remote_intl";
  if (others.size > 0) return "latam_local";
  if (job.open_to_mx || OPEN_RE.test(loc)) return "remote_intl";
  return null;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** Linear-interpolation percentile (p in 0..1) over a sorted array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface GroupStats {
  n: number;
  insufficient: boolean;
  p25: number | null;
  median: number | null;
  p75: number | null;
  min: number | null;
  max: number | null;
  hourly: number;
}

const round = (n: number) => Math.round(n);

export function groupStats(values: number[], hourly = 0): GroupStats {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const enough = n >= MIN_SAMPLE;
  return {
    n,
    insufficient: !enough,
    p25: enough ? round(percentile(sorted, 0.25)) : null,
    median: enough ? round(percentile(sorted, 0.5)) : null,
    p75: enough ? round(percentile(sorted, 0.75)) : null,
    min: n ? round(sorted[0]) : null,
    max: n ? round(sorted[n - 1]) : null,
    hourly,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface SkillRow {
  id: string;
  label: string;
  /** Unique postings relevant to the skill (with or without pay). */
  relevant: number;
  groups: Record<Group, GroupStats>;
}

export interface Discards {
  no_salary: number;
  unknown_currency: number;
  no_period: number;
  noise_low: number;
  noise_high: number;
  unclassified: number;
  irrelevant: number;
}

export interface SkillAggregate {
  version: 1;
  generated_at: string;
  currency: "MXN";
  period: "month";
  fx: Record<string, number>;
  fx_source: string;
  portals: string[];
  min_sample: number;
  noise_range: [number, number];
  totals: { unique_jobs: number; relevant_jobs: number; used_with_salary: number };
  discards: Discards;
  skills: SkillRow[];
  combo: SkillRow & { requires: string; partners: string[] };
}

interface Prepared {
  job: RawJob;
  group: Group | null;
  mxn: number | null;
  hourly: boolean;
}

export function aggregate(
  jobs: RawJob[],
  fx: Record<string, number>,
  meta: { generated_at: string; portals: string[]; fx_source?: string },
): SkillAggregate {
  const discards: Discards = {
    no_salary: 0, unknown_currency: 0, no_period: 0, noise_low: 0, noise_high: 0, unclassified: 0, irrelevant: 0,
  };
  const defs = new Map(SKILLS.map((s) => [s.id, s]));
  const prepared: (Prepared & { skills: Set<string> })[] = [];
  let used = 0;
  let relevantJobs = 0;
  for (const job of jobs) {
    const skills = new Set(SKILLS.filter((s) => isRelevant(job, s)).map((s) => s.id));
    if (skills.size === 0) {
      discards.irrelevant++;
      continue;
    }
    relevantJobs++;
    const out = monthlyMxn(job, fx);
    if (!out.ok) {
      discards[out.reason]++;
      prepared.push({ job, group: null, mxn: null, hourly: false, skills });
      continue;
    }
    const group = classifyGroup(job);
    if (!group) {
      discards.unclassified++;
      prepared.push({ job, group: null, mxn: null, hourly: false, skills });
      continue;
    }
    used++;
    prepared.push({ job, group, mxn: out.mxn, hourly: out.hourly, skills });
  }

  const rowFor = (id: string, label: string, pick: (p: (typeof prepared)[number]) => boolean): SkillRow => {
    const members = prepared.filter(pick);
    const groups = {} as Record<Group, GroupStats>;
    for (const g of GROUPS) {
      const m = members.filter((p) => p.group === g && p.mxn !== null);
      groups[g] = groupStats(m.map((p) => p.mxn as number), m.filter((p) => p.hourly).length);
    }
    return { id, label, relevant: members.length, groups };
  };

  const skills = SKILLS.map((s) => rowFor(s.id, s.label, (p) => p.skills.has(s.id)));
  const combo = {
    ...rowFor(COMBO_ID, COMBO_LABEL, (p) => p.skills.has("python") && COMBO_PARTNERS.some((id) => p.skills.has(id))),
    requires: "python",
    partners: COMBO_PARTNERS.map((id) => defs.get(id)!.label),
  };
  return {
    version: 1,
    generated_at: meta.generated_at,
    currency: "MXN",
    period: "month",
    fx,
    fx_source: meta.fx_source ?? "default",
    portals: meta.portals,
    min_sample: MIN_SAMPLE,
    noise_range: [NOISE_LOW, NOISE_HIGH],
    totals: { unique_jobs: jobs.length, relevant_jobs: relevantJobs, used_with_salary: used },
    discards,
    skills,
    combo,
  };
}

// ---------------------------------------------------------------------------
// Weak external reference (Talently) and automatic sentences
// ---------------------------------------------------------------------------

export interface ReferenceBand {
  skill: string;
  level: "mid" | "sr";
  min_usd: number;
  max_usd: number;
}
export const WEAK_REFERENCE = {
  source: "Talently",
  note: "Fuente débil: fuentes internas, sin muestra",
  url: "https://talently.tech/herramientas/mexico/salario/skill/python",
  bands: [
    { skill: "python", level: "mid", min_usd: 2563, max_usd: 3371 },
    { skill: "python", level: "sr", min_usd: 4300, max_usd: 5533 },
    { skill: "kubernetes", level: "mid", min_usd: 2477, max_usd: 3244 },
    { skill: "kubernetes", level: "sr", min_usd: 3517, max_usd: 4705 },
    { skill: "react_native", level: "mid", min_usd: 2900, max_usd: 3800 },
    { skill: "react_native", level: "sr", min_usd: 3600, max_usd: 4700 },
  ] as ReferenceBand[],
};

const kilo = (n: number) => `$${Math.round(n / 1000)}k`;

/** Domains / industries, not job skills: never used for "best paid" claims. */
export const DOMAIN_SKILL_IDS = ["fintech", "cfdi", "contable"];
export const COMBO_DISPLAY_LABEL = COMBO_LABEL; // also applied to aggregates stored with the old label

export interface ScopeStat {
  group: Group;
  n: number;
  p25: number;
  median: number;
  p75: number;
}
export interface RankedRow {
  id: string;
  label: string;
  /** Median of the best (highest-median) reliable scope. */
  median: number;
  scope: ScopeStat;
  /** Every reliable scope, best first. */
  scopes: ScopeStat[];
}
export interface FewDataRow {
  id: string;
  label: string;
  /** Postings found for the skill, with or without pay. */
  relevant: number;
  /** Largest salary sample in any scope. */
  n: number;
  domain: boolean;
}
export interface Summary {
  lead: string | null;
  ranked: RankedRow[];
  fewData: FewDataRow[];
}

function reliableScopes(row: SkillRow): ScopeStat[] {
  return GROUPS.flatMap((g) => {
    const s = row.groups[g];
    return s.insufficient ? [] : [{ group: g, n: s.n, p25: s.p25 as number, median: s.median as number, p75: s.p75 as number }];
  }).sort((a, b) => b.median - a.median);
}

/**
 * What the page shows: a lead sentence plus a ranking, both from reliable
 * samples (n >= MIN_SAMPLE) of core skills only. Domain areas (accounting,
 * fintech, CFDI) never rank. Everything else goes to `fewData`.
 */
export function buildSummary(agg: SkillAggregate): Summary {
  const ranked: RankedRow[] = [];
  const fewData: FewDataRow[] = [];
  const rows: SkillRow[] = [{ ...agg.combo, label: COMBO_DISPLAY_LABEL }, ...agg.skills];
  for (const row of rows) {
    const domain = DOMAIN_SKILL_IDS.includes(row.id);
    const scopes = reliableScopes(row);
    if (scopes.length && !domain) ranked.push({ id: row.id, label: row.label, median: scopes[0].median, scope: scopes[0], scopes });
    else if (row.id !== COMBO_ID || row.relevant > 0) {
      fewData.push({ id: row.id, label: row.label, relevant: row.relevant, n: Math.max(...GROUPS.map((g) => row.groups[g].n)), domain });
    }
  }
  ranked.sort((a, b) => b.median - a.median);

  const core = ranked.filter((r) => r.id !== COMBO_ID);
  const local = core.flatMap((r) => r.scopes.filter((s) => s.group !== "remote_intl").map((s) => s.median));
  const remote = core
    .flatMap((r) => r.scopes.filter((s) => s.group === "remote_intl").map((s) => ({ label: r.label, median: s.median })))
    .sort((a, b) => b.median - a.median)[0];
  const parts: string[] = [];
  if (local.length) {
    const where = core.some((r) => r.scopes.some((s) => s.group === "mx")) ? "en México y LatAm" : "en LatAm";
    const lo = Math.min(...local), hi = Math.max(...local);
    parts.push(`${where} pagan alrededor de ${kilo(lo)}${kilo(lo) === kilo(hi) ? "" : `–${kilo(hi)}`} al mes`);
  }
  if (remote) parts.push(`en remoto abierto a México, hasta ~${kilo(remote.median)} (${remote.label})`);
  return { lead: parts.length ? `Con tus habilidades, ${parts.join("; ")}.` : null, ranked, fewData };
}

// ---------------------------------------------------------------------------
// FX from CLAUDE.md
// ---------------------------------------------------------------------------

/** Reads "**FX to MXN:** USD=18.5, EUR=20 <!-- ... -->" from CLAUDE.md, merged over the defaults. */
export function readFx(root: string): { fx: Record<string, number>; source: string } {
  const fx = { ...DEFAULT_FX };
  const path = join(root, "CLAUDE.md");
  if (!existsSync(path)) return { fx, source: "default" };
  const m = readFileSync(path, "utf8").match(/\*\*FX to MXN:\*\*\s*([^\n]*)/i);
  if (!m) return { fx, source: "default" };
  const body = m[1].replace(/<!--[\s\S]*?(-->|$)/g, "");
  let found = false;
  for (const part of body.split(",")) {
    const kv = part.trim().match(/^([A-Za-z]{3})\s*=\s*([\d.]+)$/);
    if (kv && Number(kv[2]) > 0) {
      fx[kv[1].toUpperCase()] = Number(kv[2]);
      found = true;
    }
  }
  return { fx, source: found ? "CLAUDE.md" : "default" };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export const aggregatePath = (root: string) => join(root, "ui", "state", "skill_salaries.json");
export const rawDir = (root: string) => join(root, "ui", "state", "skill_salaries");

function writeAtomic(path: string, data: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, path);
}

export function loadAggregate(root: string): SkillAggregate | null {
  const path = aggregatePath(root);
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && v.version === 1 && Array.isArray(v.skills) && v.combo ? (v as SkillAggregate) : null;
  } catch {
    return null;
  }
}

/** True when there is no aggregate or it is older than `days`. */
export function isStale(root: string, now: Date = new Date(), days = STALE_DAYS): boolean {
  const agg = loadAggregate(root);
  if (!agg) return true;
  const t = Date.parse(agg.generated_at);
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t > days * 86_400_000;
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

export type CliSpawner = (argv: string[], cwd: string) => Promise<{ code: number; stdout: string }>;

export const bunCliSpawner: CliSpawner = async (argv, cwd) => {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const stdout = await new Response(proc.stdout).text();
  return { code: await proc.exited, stdout };
};

export interface CallRecord {
  portal: string;
  query: string;
  variant: string;
  page: number;
  count: number | null;
  error?: string;
}

export interface SampleOptions {
  root: string;
  spawn?: CliSpawner;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  bun?: string;
  skills?: SkillDef[];
  portals?: PortalPlan[];
  pauseMs?: number;
  log?: (line: string) => void;
}

export interface SampleResult {
  aggregate: SkillAggregate;
  rawPath: string;
  calls: CallRecord[];
}

/** Parses the CLI's `{ results: [...] }` JSON. Returns null on any failure. */
export function parseCliOutput(stdout: string): unknown[] | null {
  try {
    const v = JSON.parse(stdout);
    return Array.isArray(v?.results) ? v.results : null;
  } catch {
    return null;
  }
}

export async function sampleAll(opts: SampleOptions): Promise<SampleResult> {
  const spawn = opts.spawn ?? bunCliSpawner;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = opts.now ?? (() => new Date());
  const bun = opts.bun ?? process.execPath;
  const skills = opts.skills ?? SKILLS;
  const portals = opts.portals ?? PORTALS;
  const pause = opts.pauseMs ?? PAUSE_MS;
  const log = opts.log ?? (() => {});
  const jobs = new Map<string, RawJob>();
  const calls: CallRecord[] = [];
  const queries = [...new Set(skills.flatMap((s) => s.queries))];
  const total = queries.length * portals.reduce((n, p) => n + p.variants.length, 0);
  let step = 0;

  for (const query of queries) {
    for (const plan of portals) {
      for (const variant of plan.variants) {
        step++;
        log(`(${step}/${total}) ${plan.portal} · "${query}" · ${variant.name}`);
        for (let page = 1; page <= 2; page++) {
          const rec: CallRecord = { portal: plan.portal, query, variant: variant.name, page, count: null };
          calls.push(rec);
          let rows: unknown[] | null = null;
          try {
            const res = await spawn(buildArgv(bun, opts.root, plan.portal, query, variant.args, page), opts.root);
            rows = res.code === 0 ? parseCliOutput(res.stdout) : null;
            if (rows === null) rec.error = res.code === 0 ? "bad_output" : `exit_${res.code}`;
          } catch (err) {
            rec.error = `spawn_failed: ${(err as Error).message}`.slice(0, 200);
          }
          await sleep(pause);
          if (rows === null) break;
          rec.count = rows.length;
          for (const row of rows) {
            const job = toRawJob(plan.portal, row, variant, query);
            if (job) addJob(jobs, job);
          }
          if (!variant.paged || rows.length < PAGE_SIZE) break;
        }
      }
    }
  }

  const generatedAt = now().toISOString();
  const { fx, source } = readFx(opts.root);
  const list = [...jobs.values()];
  const agg = aggregate(list, fx, { generated_at: generatedAt, portals: portals.map((p) => p.portal), fx_source: source });
  const date = generatedAt.slice(0, 10);
  const rawPath = join(rawDir(opts.root), `raw-${date}.json`);
  writeAtomic(rawPath, { fetched_at: generatedAt, fx, calls, jobs: list });
  writeAtomic(aggregatePath(opts.root), agg);
  return { aggregate: agg, rawPath, calls };
}

/** Only the aggregate's age matters to callers that gate on it. */
export function aggregateAgeDays(root: string, now: Date = new Date()): number | null {
  const agg = loadAggregate(root);
  if (!agg) return null;
  return (now.getTime() - Date.parse(agg.generated_at)) / 86_400_000;
}

export function fileMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
