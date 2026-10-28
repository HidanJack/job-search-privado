import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  KNOWN_CODES, parseRequirements, requirementAssessment, spokenGapLanguage, userLevels,
  type LanguageLevel, type LanguageNeed, type LanguageRequirement,
} from "./language_levels";
import { isBlocked, type BlockedCompany } from "./blocklist";

// /scrape can resolve `job_scraper/` relative to its own skill directory, so
// the state file may live in either place (see .gitignore). The repo-root copy
// wins when a key exists in both.
export const STATE_PATHS = [
  join(".claude", "skills", "job-scraper", "job_scraper", "seen_jobs.json"),
  join("job_scraper", "seen_jobs.json"),
];

export type Modality = "remote" | "hybrid" | "onsite" | "unknown";
export const MODALITIES: Modality[] = ["remote", "hybrid", "onsite", "unknown"];

/** ISO 639-1 code of the language a posting is written in ("es", "en", "de"...), or "mixed" (bilingual). */
export type PostingLanguage = string;
export const POSTING_LANGUAGES: PostingLanguage[] = [...KNOWN_CODES, "mixed"];

export interface Job {
  key: string;
  title: string;
  company: string;
  url: string | null;
  portal: string | null;
  location: string | null;
  status: string;
  posted_date: string | null;
  first_seen: string | null;
  age_days: number | null;
  rank_score: number | null;
  priority_score: number | null;
  rank_verdict: string | null;
  location_verdict: string | null;
  language_gate: string | null;
  language_note: string | null;
  posting_language: PostingLanguage | null;
  spoken_english: boolean;
  /** Code of the language the job probably needs spoken and the candidate lacks (any language); null when none. */
  spoken_language: string | null;
  /** What the posting really asks (tools/language_requirement.py); null = never analysed (old rule applies). */
  language_requirements: LanguageRequirement[] | null;
  /** Derived from the requirements and the candidate's levels (see filterJobs); null before that. */
  language_need: LanguageNeed | null;
  /** Verbatim quote behind `language_need`, when there is one. */
  language_evidence: string | null;
  role_family: string | null;
  deadline: string | null;
  modality: Modality;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_period: string | null;
  salary_mxn_month: number | null;
  fit_reasons: string[];
  strengths: string[];
  gaps: string[];
  /** Deterministic pre-ranking relevance (tools/prefilter.py). */
  prefilter_score: number | null;
  /** Spanish one-liners from the learned scorer ("Sube: python, fastapi"), when a model scored it. */
  prefilter_why: string[];
  /** Spanish reason when status is "prefiltered_out". */
  prefilter_reason: string | null;
  /** The user asked for this job to be ranked in the next run despite a low prefilter score. */
  force_rank: boolean;
  /** The posting was published again (used to suggest companies for the blocklist). */
  reposted: boolean;
  /** Opportunity / risk (tools/opportunity.py), computed after /rank. */
  opportunity: number | null;
  risk: number | null;
  final_priority: number | null;
  opportunity_driver: string | null;
  risk_driver: string | null;
}

export interface Filters {
  maxDays: number;
  minSalaryMxn: number;
  includeNoSalary: boolean;
  includeUndated: boolean;
  /** Hide only the postings that explicitly demand a spoken language above the candidate's level. */
  hideSpokenGap: boolean;
  modalities: Modality[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strList = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max) : [];

const SPOKEN_ENGLISH = /spoken english|inglés (hablado|conversacional)|english[^.]{0,40}(interview|conversation|calls?)/i;

/** True when the stored language fields say the job likely needs spoken English. */
export function needsSpokenEnglish(gate: string | null, note: string | null, lang: PostingLanguage | null): boolean {
  if (gate !== "FLAG" && gate !== "FAIL") return false;
  return lang === "en" || (note !== null && SPOKEN_ENGLISH.test(note));
}

/** The spoken language a FLAG/FAIL gate points at: the posting's language, else the one a note names. */
export function spokenLanguageGap(gate: string | null, note: string | null, lang: PostingLanguage | null): string | null {
  if (gate !== "FLAG" && gate !== "FAIL") return null;
  if (needsSpokenEnglish(gate, note, lang)) return "en";
  if (lang && lang !== "es" && lang !== "mixed") return lang;
  return note ? spokenGapLanguage(note) : null;
}

// Title-only keyword match. Deliberately conservative: unknown titles get no family.
const FAMILY_RULES: [string, RegExp][] = [
  ["QA / pruebas", /\b(qa|tester|quality assurance|automatizaci[oó]n de pruebas|test automation)\b/i],
  ["RPA / automatización", /\b(rpa|automation engineer|automatizaci[oó]n)\b/i],
  ["Analista de datos / BI", /\b(data analyst|analista de datos|analista bi|bi analyst|business intelligence)\b/i],
  ["Datos", /\b(data engineer|ingeniero de datos|etl)\b/i],
  ["IA", /\b(ai engineer|machine learning|ml engineer|llm|inteligencia artificial)\b/i],
  ["Frontend / web", /\b(front-?end|web developer|desarrollador web|landing|wordpress|react)\b/i],
  ["Soporte / implementación", /\b(soporte t[eé]cnico|technical support|implementaci[oó]n|implementation|cfdi)\b/i],
  ["Backend", /\b(backend|back-end|python)\b/i],
];

export function inferRoleFamily(title: string): string | null {
  for (const [label, re] of FAMILY_RULES) if (re.test(title)) return label;
  return null;
}

/** Days between a stored date (YYYY-MM-DD or ISO) and today; null if unparseable. */
export function ageInDays(value: string | null, today: Date): number | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  const posted = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  if (Number.isNaN(posted)) return null;
  return Math.max(0, Math.round((now - posted) / 86_400_000));
}

export function normalizeJob(key: string, raw: Record<string, unknown>, today: Date): Job {
  const modality = MODALITIES.includes(raw.modality as Modality) ? (raw.modality as Modality) : "unknown";
  const posted = str(raw.posted_date);
  const title = str(raw.title) ?? "(sin título)";
  const gate = str(raw.language_gate);
  const note = str(raw.language_note);
  const lang = POSTING_LANGUAGES.includes(raw.posting_language as PostingLanguage)
    ? (raw.posting_language as PostingLanguage)
    : null;
  return {
    key,
    title,
    company: str(raw.company) ?? "(sin empresa)",
    url: str(raw.url),
    portal: str(raw.portal),
    location: str(raw.location),
    status: str(raw.status) ?? "new",
    posted_date: posted,
    first_seen: str(raw.first_seen),
    age_days: ageInDays(posted, today),
    rank_score: num(raw.rank_score),
    priority_score: num(raw.priority_score) ?? num(raw.rank_score),
    rank_verdict: str(raw.rank_verdict),
    location_verdict: str(raw.location_verdict),
    language_gate: gate,
    language_note: note,
    posting_language: lang,
    spoken_english: needsSpokenEnglish(gate, note, lang),
    spoken_language: spokenLanguageGap(gate, note, lang),
    language_requirements: parseRequirements(raw.language_requirements),
    language_need: null,
    language_evidence: null,
    role_family: inferRoleFamily(title),
    deadline: str(raw.deadline),
    modality,
    salary_min: num(raw.salary_min),
    salary_max: num(raw.salary_max),
    salary_currency: str(raw.salary_currency),
    salary_period: str(raw.salary_period),
    salary_mxn_month: num(raw.salary_mxn_month),
    fit_reasons: strList(raw.fit_reasons, 4),
    strengths: strList(raw.strengths, 3),
    gaps: strList(raw.gaps, 3),
    prefilter_score: num(raw.prefilter_score),
    prefilter_why: strList(raw.prefilter_why, 3),
    prefilter_reason: str(raw.prefilter_reason),
    force_rank: raw.force_rank === true,
    reposted: raw.reposted === true,
    opportunity: num(raw.opportunity),
    risk: num(raw.risk),
    final_priority: num(raw.final_priority),
    opportunity_driver: str(raw.opportunity_driver),
    risk_driver: str(raw.risk_driver),
  };
}

function readState(path: string): Record<string, Record<string, unknown>> {
  if (!existsSync(path)) return {};
  try {
    const doc = JSON.parse(readFileSync(path, "utf8"));
    const seen = doc && typeof doc === "object" ? doc.seen : null;
    return seen && typeof seen === "object" ? seen : {};
  } catch {
    return {};
  }
}

export function loadJobs(root: string, today: Date): Job[] {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const rel of STATE_PATHS) Object.assign(merged, readState(join(root, rel)));
  return Object.entries(merged)
    .filter(([, v]) => v && typeof v === "object")
    .map(([k, v]) => normalizeJob(k, v, today));
}

const vetoed = (j: Job) => j.location_verdict === "FAIL" || j.language_gate === "FAIL";

function passesAge(j: Job, f: Filters): boolean {
  return j.age_days === null ? f.includeUndated : j.age_days <= f.maxDays;
}

/**
 * Fills `language_need` / `language_evidence` from the posting's requirements and the candidate's levels.
 * Jobs never analysed (no requirements) keep the old rule: a posting in a language below B1 counts as a spoken gap.
 */
export function withLanguageNeed(j: Job, languages?: LanguageLevel[]): Job {
  const a = requirementAssessment(j.posting_language, j.language_requirements, userLevels(languages));
  // The gate of an analysed posting can stay FLAG for "level not stated": that is not a spoken requirement.
  const notSpoken = !a.legacy && a.need !== "spoken" && j.spoken_language !== null && j.spoken_language === j.posting_language;
  return {
    ...j, language_need: a.need, language_evidence: a.evidence,
    spoken_language: notSpoken ? null : j.spoken_language,
    spoken_english: notSpoken && j.spoken_language === "en" ? false : j.spoken_english,
  };
}

/** `languages` is profile_config.json's list; without it the legacy default applies (Spanish native, English speak A2). */
export function filterJobs(
  jobs: Job[], f: Filters, languages?: LanguageLevel[], blocked: BlockedCompany[] = [],
): { ranked: Job[]; unranked: Job[] } {
  const visible = (j: Job) => !isBlocked(j.company, blocked);
  const ranked = jobs
    .filter((j) => j.status === "ranked" && !vetoed(j) && visible(j))
    .filter((j) => passesAge(j, f))
    .map((j) => withLanguageNeed(j, languages))
    // Absence of the field is not evidence of a language: only an explicit spoken requirement hides.
    .filter((j) => !(f.hideSpokenGap && j.language_need === "spoken"))
    .filter((j) => (j.salary_mxn_month === null ? f.includeNoSalary : j.salary_mxn_month >= f.minSalaryMxn))
    .filter((j) => f.modalities.includes(j.modality))
    .sort(
      (a, b) =>
        (b.final_priority ?? b.priority_score ?? -1) - (a.final_priority ?? a.priority_score ?? -1) ||
        (a.age_days ?? 9999) - (b.age_days ?? 9999),
    );
  const unranked = jobs
    .filter((j) => j.status === "new" && visible(j))
    .filter((j) => passesAge(j, f))
    // Same order /rank will use: best prefilter score first.
    .sort((a, b) => (b.prefilter_score ?? -1) - (a.prefilter_score ?? -1) || (a.age_days ?? 9999) - (b.age_days ?? 9999));
  return { ranked, unranked };
}

export interface FilterDefaults {
  maxDays: number;
  minSalaryMxn: number;
  includeNoSalary?: boolean;
  includeUndated?: boolean;
  hideSpokenGap?: boolean;
  /** Older names of `hideSpokenGap`; read as aliases (hideUnspoken first, then hideEnglish). */
  hideUnspoken?: boolean;
  hideEnglish?: boolean;
  modalities?: Modality[];
}

export function parseFilters(params: URLSearchParams, defaults: FilterDefaults): Filters {
  const int = (name: string, fallback: number, max: number) => {
    const v = Number(params.get(name));
    return params.has(name) && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), max) : fallback;
  };
  const flag = (name: string, fallback: boolean) => (params.has(name) ? params.get(name) === "1" : fallback);
  const requested = (params.get("modality") ?? "").split(",").filter((m): m is Modality => MODALITIES.includes(m as Modality));
  return {
    maxDays: int("maxDays", defaults.maxDays, 365),
    minSalaryMxn: int("minSalary", defaults.minSalaryMxn, 10_000_000),
    includeNoSalary: flag("includeNoSalary", defaults.includeNoSalary ?? true),
    includeUndated: flag("includeUndated", defaults.includeUndated ?? true),
    // `hideUnspoken` and `hideEnglish` are older names: still read from the URL and the defaults, newest name wins.
    hideSpokenGap: params.has("hideSpokenGap")
      ? params.get("hideSpokenGap") === "1"
      : params.has("hideUnspoken")
        ? params.get("hideUnspoken") === "1"
        : flag("hideEnglish", defaults.hideSpokenGap ?? defaults.hideUnspoken ?? defaults.hideEnglish ?? true),
    modalities: params.has("modality") ? requested : [...(defaults.modalities ?? MODALITIES)],
  };
}

export const PREFILTERED_OUT = "prefiltered_out";

/** Same rule as `rank_state.py candidates`: a new job goes to /rank on its own only at or above the gate (or when forced). */
export function passesGate(job: Job, minScore: number): boolean {
  return job.force_rank || job.prefilter_score === null || job.prefilter_score >= minScore;
}

/** Splits pending jobs into those /rank will pick up and those held back by the score gate. */
export function splitByGate(jobs: Job[], minScore: number): { eligible: Job[]; gated: Job[] } {
  return {
    eligible: jobs.filter((j) => passesGate(j, minScore)),
    gated: jobs.filter((j) => !passesGate(j, minScore)),
  };
}

/** Jobs the deterministic prefilter discarded (kept on disk, best score first). */
export function prefilteredJobs(jobs: Job[]): Job[] {
  return jobs
    .filter((j) => j.status === PREFILTERED_OUT)
    .sort((a, b) => (b.prefilter_score ?? -1) - (a.prefilter_score ?? -1));
}

/** Marks one posting as dismissed in whichever state file holds it. */
export function skipJob(root: string, key: string): boolean {
  return updateJob(root, key, (e) => {
    e.status = "skipped";
    return true;
  });
}

/** Moves an auto-discarded posting back to the pending pool; the prefilter never discards it again. */
export function recoverJob(root: string, key: string): boolean {
  return updateJob(root, key, (e) => {
    if (e.status !== PREFILTERED_OUT) return false;
    e.status = "new";
    e.prefilter_recovered = true;
    delete e.prefilter_reason;
    return true;
  });
}

/** Flags one pending job so the next /rank run scores it even below the gate (cleared by `rank_state.py apply`). */
export function forceRankJob(root: string, key: string): boolean {
  return updateJob(root, key, (e) => {
    if (e.status !== "new") return false;
    e.force_rank = true;
    return true;
  });
}

function updateJob(root: string, key: string, change: (entry: Record<string, unknown>) => boolean): boolean {
  for (const rel of [...STATE_PATHS].reverse()) {
    const path = join(root, rel);
    if (!existsSync(path)) continue;
    const doc = JSON.parse(readFileSync(path, "utf8"));
    if (!doc?.seen?.[key]) continue;
    if (!change(doc.seen[key])) return false;
    const tmp = join(dirname(path), `.seen_jobs.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
    renameSync(tmp, path);
    return true;
  }
  return false;
}
