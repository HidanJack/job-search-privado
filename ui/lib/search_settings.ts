import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MODALITIES, type Modality } from "./jobs";
import { MAX_SALARY, settingsPath } from "./market";
import { DEFAULT_PROFILE_CONFIG, loadProfileConfig } from "./profile_config";

/** Search window and view filters, shared by the Vacantes tab and the sweep. */
export interface SearchSettings {
  maxDays: number;
  minSalaryMxn: number;
  modalities: Modality[];
  /** Hide only postings that explicitly demand a spoken language above the candidate's speaking level. */
  hideSpokenGap: boolean;
  includeUnpublishedSalary: boolean;
  includeUndated: boolean;
  /** How many pending jobs /rank scores per run (best prefilter score first). */
  rankBatch: number;
  /** Deterministic gate: only `new` jobs with prefilter_score >= this go to /rank on their own. */
  minPrefilterScore: number;
}

export const MAX_SEARCH_DAYS = 90;
export const MAX_RANK_BATCH = 200;
export const MAX_PREFILTER_SCORE = 100;

export const DEFAULT_SEARCH: SearchSettings = {
  maxDays: 7,
  minSalaryMxn: DEFAULT_PROFILE_CONFIG.salary_floor_mxn, // overridden per user by profile_config.json
  modalities: [...MODALITIES],
  hideSpokenGap: true,
  includeUnpublishedSalary: true,
  includeUndated: true,
  rankBatch: 10,
  minPrefilterScore: 55,
};

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isModalities = (v: unknown): v is Modality[] =>
  Array.isArray(v) && v.every((m) => MODALITIES.includes(m as Modality)) && new Set(v).size === v.length;

const VALIDATORS: { [K in keyof SearchSettings]: (v: unknown) => boolean } = {
  maxDays: (v) => isInt(v, 1, MAX_SEARCH_DAYS),
  minSalaryMxn: (v) => isInt(v, 0, MAX_SALARY),
  modalities: isModalities,
  hideSpokenGap: isBool,
  includeUnpublishedSalary: isBool,
  includeUndated: isBool,
  rankBatch: (v) => isInt(v, 1, MAX_RANK_BATCH),
  minPrefilterScore: (v) => isInt(v, 0, MAX_PREFILTER_SCORE),
};

/** Strict: a non-empty object of known keys whose values are all in range. */
export function parseSearchPatch(raw: unknown): Partial<SearchSettings> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entries = Object.entries(raw);
  if (entries.length === 0) return null;
  const out: Record<string, unknown> = {};
  // `hideUnspoken` and `hideEnglish` are older names of `hideSpokenGap`: accepted as aliases, the newest name wins.
  const has = (k: string) => k in (raw as object);
  for (const [rawKey, value] of entries) {
    const alias = rawKey === "hideUnspoken" || rawKey === "hideEnglish";
    const key = alias ? "hideSpokenGap" : rawKey;
    if (rawKey === "hideEnglish" && (has("hideSpokenGap") || has("hideUnspoken"))) continue;
    if (rawKey === "hideUnspoken" && has("hideSpokenGap")) continue;
    const check = (VALIDATORS as Record<string, (v: unknown) => boolean>)[key];
    if (!check || !check(value)) return null;
    out[key] = key === "modalities" ? [...(value as string[])] : value;
  }
  return out as Partial<SearchSettings>;
}

function readFileJson(root: string): Record<string, unknown> {
  const path = settingsPath(root);
  if (!existsSync(path)) return {};
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Reads settings.json["search"]; every invalid field falls back to its default. */
export function loadSearchSettings(root: string): SearchSettings {
  const raw = readFileJson(root).search;
  const out: SearchSettings = {
    ...DEFAULT_SEARCH, modalities: [...DEFAULT_SEARCH.modalities],
    minSalaryMxn: loadProfileConfig(root).salary_floor_mxn,
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const stored = raw as Record<string, unknown>;
  for (const [key, check] of Object.entries(VALIDATORS)) {
    let value = stored[key];
    // Older settings only have `hideUnspoken`, and before that `hideEnglish`: read the newest present name.
    if (key === "hideSpokenGap" && value === undefined) value = stored.hideUnspoken !== undefined ? stored.hideUnspoken : stored.hideEnglish;
    if (value !== undefined && check(value)) (out as unknown as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** Writes only the "search" key; the salary keys in the same file are kept. */
export function saveSearchSettings(root: string, search: SearchSettings): void {
  const path = settingsPath(root);
  const doc = { ...readFileJson(root), search };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

/** Demand estimation for career-path discovery: a wider window than the user's application window. */
export const DEFAULT_DISCOVERY_WINDOW_DAYS = 30;
export interface DiscoverySettings { windowDays: number }

/** Reads settings.json["discovery"].window_days (integer 1-90); anything else falls back to 30. */
export function loadDiscoverySettings(root: string): DiscoverySettings {
  const raw = readFileJson(root).discovery;
  const v = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).window_days : undefined;
  return { windowDays: isInt(v, 1, MAX_SEARCH_DAYS) ? v : DEFAULT_DISCOVERY_WINDOW_DAYS };
}
