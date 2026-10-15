import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// /scrape can resolve `job_scraper/` relative to its own skill directory, so
// the state file may live in either place (see .gitignore). The repo-root copy
// wins when a key exists in both.
export const STATE_PATHS = [
  join(".claude", "skills", "job-scraper", "job_scraper", "seen_jobs.json"),
  join("job_scraper", "seen_jobs.json"),
];

export type Modality = "remote" | "hybrid" | "onsite" | "unknown";
export const MODALITIES: Modality[] = ["remote", "hybrid", "onsite", "unknown"];

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
}

export interface Filters {
  maxDays: number;
  minSalaryMxn: number;
  includeNoSalary: boolean;
  includeUndated: boolean;
  modalities: Modality[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strList = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max) : [];

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
  return {
    key,
    title: str(raw.title) ?? "(sin título)",
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
    language_gate: str(raw.language_gate),
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

export function filterJobs(jobs: Job[], f: Filters): { ranked: Job[]; unranked: Job[] } {
  const ranked = jobs
    .filter((j) => j.status === "ranked" && !vetoed(j))
    .filter((j) => passesAge(j, f))
    .filter((j) => (j.salary_mxn_month === null ? f.includeNoSalary : j.salary_mxn_month >= f.minSalaryMxn))
    .filter((j) => f.modalities.includes(j.modality))
    .sort(
      (a, b) =>
        (b.priority_score ?? -1) - (a.priority_score ?? -1) ||
        (a.age_days ?? 9999) - (b.age_days ?? 9999),
    );
  const unranked = jobs
    .filter((j) => j.status === "new")
    .filter((j) => passesAge(j, f))
    .sort((a, b) => (a.age_days ?? 9999) - (b.age_days ?? 9999));
  return { ranked, unranked };
}

export function parseFilters(params: URLSearchParams, defaults: { maxDays: number; minSalaryMxn: number }): Filters {
  const int = (name: string, fallback: number, max: number) => {
    const v = Number(params.get(name));
    return params.has(name) && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), max) : fallback;
  };
  const flag = (name: string, fallback: boolean) => (params.has(name) ? params.get(name) === "1" : fallback);
  const requested = (params.get("modality") ?? "").split(",").filter((m): m is Modality => MODALITIES.includes(m as Modality));
  return {
    maxDays: int("maxDays", defaults.maxDays, 365),
    minSalaryMxn: int("minSalary", defaults.minSalaryMxn, 10_000_000),
    includeNoSalary: flag("includeNoSalary", true),
    includeUndated: flag("includeUndated", true),
    modalities: params.has("modality") ? requested : [...MODALITIES],
  };
}

/** Marks one posting as dismissed in whichever state file holds it. */
export function skipJob(root: string, key: string): boolean {
  for (const rel of [...STATE_PATHS].reverse()) {
    const path = join(root, rel);
    if (!existsSync(path)) continue;
    const doc = JSON.parse(readFileSync(path, "utf8"));
    if (!doc?.seen?.[key]) continue;
    doc.seen[key].status = "skipped";
    const tmp = join(dirname(path), `.seen_jobs.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
    renameSync(tmp, path);
    return true;
  }
  return false;
}
