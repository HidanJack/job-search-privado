import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Job } from "./jobs";

export const MARKET_PATH = join(import.meta.dir, "..", "data", "market_salaries.json");
/** The Python-in-Mexico entry is the benchmark the automatic readings compare against. */
export const BENCHMARK_ID = "python-mx";
export const MAX_SALARY = 1_000_000;
/** Within this fraction of the benchmark average we say "at the average". */
export const AVERAGE_TOLERANCE = 0.1;

export type Evidence = "verified" | "dubious";

export interface MarketEntry {
  id: string;
  role: string;
  region: string;
  avg: number | null;
  min: number | null;
  max: number | null;
  source: string;
  url: string | null;
  date: string;
  evidence: Evidence;
  note: string;
}

export interface MarketData {
  version: number;
  currency: "MXN";
  period: "month";
  gross: boolean;
  entries: MarketEntry[];
}

const isMoney = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= MAX_SALARY;
const isNullableMoney = (v: unknown): v is number | null => v === null || isMoney(v);
const isText = (v: unknown, max = 400): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;

/** Throws a descriptive Error when the reference data is malformed. */
export function validateMarket(raw: unknown): MarketData {
  const fail = (msg: string): never => {
    throw new Error(`market_salaries.json: ${msg}`);
  };
  if (!raw || typeof raw !== "object") return fail("not an object");
  const doc = raw as Record<string, unknown>;
  if (doc.version !== 1) fail("unsupported version");
  if (doc.currency !== "MXN" || doc.period !== "month") fail("currency/period must be MXN/month");
  if (!Array.isArray(doc.entries) || doc.entries.length === 0) return fail("entries must be a non-empty array");
  const ids = new Set<string>();
  const entries = doc.entries.map((e, i): MarketEntry => {
    const where = `entries[${i}]`;
    if (!e || typeof e !== "object") return fail(`${where} not an object`);
    const r = e as Record<string, unknown>;
    if (!isText(r.id, 80) || ids.has(r.id)) fail(`${where}.id missing or duplicated`);
    ids.add(r.id as string);
    if (!isText(r.role)) fail(`${where}.role missing`);
    if (!isText(r.region)) fail(`${where}.region missing`);
    if (!isText(r.source)) fail(`${where}.source missing`);
    if (!isText(r.note)) fail(`${where}.note missing`);
    if (typeof r.date !== "string" || !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(r.date)) fail(`${where}.date must be YYYY, YYYY-MM or YYYY-MM-DD`);
    if (r.evidence !== "verified" && r.evidence !== "dubious") fail(`${where}.evidence must be verified or dubious`);
    if (r.url !== null && !(typeof r.url === "string" && /^https:\/\/[^\s]+$/.test(r.url))) fail(`${where}.url must be https or null`);
    if (!isNullableMoney(r.avg) || !isNullableMoney(r.min) || !isNullableMoney(r.max)) fail(`${where} amounts must be positive numbers or null`);
    const { avg, min, max } = r as { avg: number | null; min: number | null; max: number | null };
    if ((min === null) !== (max === null)) fail(`${where} min and max go together`);
    if (avg === null && min === null) fail(`${where} needs an average or a range`);
    if (min !== null && max !== null && min > max) fail(`${where} min > max`);
    if (avg !== null && min !== null && max !== null && (avg < min || avg > max)) fail(`${where} avg outside range`);
    return r as unknown as MarketEntry;
  });
  return { version: 1, currency: "MXN", period: "month", gross: doc.gross === true, entries };
}

export function loadMarket(path = MARKET_PATH): MarketData {
  return validateMarket(JSON.parse(readFileSync(path, "utf8")));
}

// ---------- personal settings (never in git: ui/state/ is ignored) ----------

export interface Settings {
  currentSalary: number | null;
  targetSalary: number | null;
}
const EMPTY_SETTINGS: Settings = { currentSalary: null, targetSalary: null };

export const settingsPath = (root: string) => join(root, "ui", "state", "settings.json");

/** Integer 0..1,000,000 or null (empty). Anything else is rejected. */
function parseAmount(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_SALARY) return v;
  return undefined;
}

/** Strict: exactly the two known keys, each an integer in range or null. */
export function parseSettings(raw: unknown): Settings | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== 2 || !keys.includes("currentSalary") || !keys.includes("targetSalary")) return null;
  const r = raw as Record<string, unknown>;
  const currentSalary = parseAmount(r.currentSalary);
  const targetSalary = parseAmount(r.targetSalary);
  if (currentSalary === undefined || targetSalary === undefined) return null;
  return { currentSalary, targetSalary };
}

export function loadSettings(root: string): Settings {
  const path = settingsPath(root);
  if (!existsSync(path)) return { ...EMPTY_SETTINGS };
  try {
    return parseSettings(JSON.parse(readFileSync(path, "utf8"))) ?? { ...EMPTY_SETTINGS };
  } catch {
    return { ...EMPTY_SETTINGS };
  }
}

export function saveSettings(root: string, settings: Settings): void {
  const path = settingsPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

// ---------- market view of the qualified jobs ----------

export interface MarketJob {
  key: string;
  title: string;
  company: string;
  salary: number;
  modality: Job["modality"];
  language: Job["posting_language"];
}

/** Ranked jobs with a published monthly salary; only what the chart needs. */
export function marketJobs(jobs: Job[]): MarketJob[] {
  return jobs
    .filter((j) => j.status === "ranked" && j.salary_mxn_month !== null && j.salary_mxn_month > 0)
    .map((j) => ({
      key: j.key, title: j.title, company: j.company, salary: Math.round(j.salary_mxn_month as number),
      modality: j.modality, language: j.posting_language,
    }))
    .sort((a, b) => a.salary - b.salary);
}

// ---------- automatic readings ----------

const fmt = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const pct = (n: number) => `${Math.round(Math.abs(n) * 100)}%`;

function versus(label: string, amount: number, bench: MarketEntry): string {
  const avg = bench.avg as number;
  const diff = (amount - avg) / avg;
  const name = `promedio de ${bench.source} para Python en ${bench.region} (${fmt(avg)})`;
  if (Math.abs(diff) <= AVERAGE_TOLERANCE) return `${label} (${fmt(amount)}) está en el ${name}.`;
  const side = diff > 0 ? "por encima del" : "por debajo del";
  let text = `${label} (${fmt(amount)}) está ${pct(diff)} ${side} ${name}`;
  if (bench.max !== null && amount > bench.max) text += ` y supera el tope del rango típico (${fmt(bench.max)})`;
  else if (bench.min !== null && amount < bench.min) text += ` y queda bajo el piso del rango típico (${fmt(bench.min)})`;
  return text + ".";
}

/** Up to three plain-Spanish sentences computed from the data; empty inputs are skipped. */
export function computeReadings(market: MarketData, jobs: MarketJob[], settings: Settings): string[] {
  const out: string[] = [];
  const bench = market.entries.find((e) => e.id === BENCHMARK_ID);
  const current = settings.currentSalary && settings.currentSalary > 0 ? settings.currentSalary : null;
  const target = settings.targetSalary && settings.targetSalary > 0 ? settings.targetSalary : null;

  if (bench && bench.avg !== null) {
    if (current !== null) out.push(versus("Tu sueldo actual", current, bench));
    if (target !== null) out.push(versus("Tu objetivo", target, bench));
  }

  if (jobs.length > 0) {
    const n = jobs.length;
    if (target !== null) {
      const hit = jobs.filter((j) => j.salary >= target);
      const remote = hit.filter((j) => j.modality === "remote").length;
      let text = `${hit.length} de tus ${n} vacantes calificadas con sueldo publicado pagan ${fmt(target)} o más`;
      if (hit.length > 0) text += remote === hit.length ? " (todas remotas)" : ` (${remote} remotas)`;
      out.push(text + ".");
    } else if (current !== null) {
      const hit = jobs.filter((j) => j.salary > current).length;
      out.push(`${hit} de tus ${n} vacantes calificadas con sueldo publicado pagan más que tu sueldo actual.`);
    } else if (bench && bench.avg !== null) {
      const hit = jobs.filter((j) => j.salary > (bench.avg as number)).length;
      out.push(`${hit} de tus ${n} vacantes calificadas con sueldo publicado superan el promedio de ${bench.source} para Python (${fmt(bench.avg)}).`);
    }
  } else {
    out.push("Todavía no hay vacantes calificadas con sueldo publicado para comparar.");
  }
  return out.slice(0, 3);
}
