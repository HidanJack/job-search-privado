import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-user numbers and skill selection from the gitignored `profile_config.json`
 * at the repo root (schema: README, profile_config.example.json). Mirrors
 * tools/profile_config.py: a missing file, bad JSON or an invalid value falls
 * back to these neutral defaults key by key and never throws.
 */
export interface ConfigQuery {
  text: string;
  lang: string;
}
export interface SearchFamily {
  name: string;
  queries: ConfigQuery[];
  /** Explicit Indeed search strings (otherwise derived from the Spanish, then English, queries). */
  indeed?: string[];
  /** Neighbour family: its Indeed strings run only on a "broad" search. */
  broad?: boolean;
}
export type Cefr = "A1" | "A2" | "B1" | "B2" | "C1" | "C2" | "native";
export interface ConfigLanguage {
  language: string;
  read: Cefr | null;
  write: Cefr | null;
  speak: Cefr | null;
}

export interface ProfileConfig {
  name: string;
  current_salary_mxn: number;
  salary_floor_mxn: number;
  languages: ConfigLanguage[];
  search: { families: SearchFamily[] };
  skills: { selected: string[]; combo_partners: string[]; primary: string };
}

/** Neutral starter families when the profile has none (mirrors DEFAULT_FAMILIES in tools/profile_config.py). */
export const DEFAULT_FAMILIES: SearchFamily[] = [
  { name: "Software / backend", queries: [
    { text: "software engineer", lang: "en" }, { text: "software developer", lang: "en" }, { text: "backend developer", lang: "en" },
    { text: "desarrollador de software", lang: "es" }, { text: "desarrollador backend", lang: "es" }] },
  { name: "Frontend / full stack", queries: [
    { text: "frontend developer", lang: "en" }, { text: "full stack developer", lang: "en" },
    { text: "desarrollador frontend", lang: "es" }, { text: "desarrollador full stack", lang: "es" }] },
  { name: "Data", queries: [
    { text: "data engineer", lang: "en" }, { text: "data analyst", lang: "en" },
    { text: "ingeniero de datos", lang: "es" }, { text: "analista de datos", lang: "es" }] },
  { name: "DevOps / QA", queries: [
    { text: "devops engineer", lang: "en" }, { text: "qa engineer", lang: "en" },
    { text: "ingeniero devops", lang: "es" }, { text: "analista QA", lang: "es" }] },
];

export const DEFAULT_PROFILE_CONFIG: ProfileConfig = {
  name: "",
  current_salary_mxn: 20000,
  salary_floor_mxn: 30000,
  languages: [],
  search: { families: DEFAULT_FAMILIES },
  skills: {
    selected: ["python", "kubernetes", "llm", "rag", "ai_engineer", "data_engineer", "etl", "fastapi", "qa_automation"],
    combo_partners: ["llm", "rag", "kubernetes"],
    primary: "python",
  },
};

export const PROFILE_CONFIG_FILE = "profile_config.json";

const isMoney = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 1_000_000;
const isIds = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string" && s.trim() !== "");

const CEFR = new Set(["A1", "A2", "B1", "B2", "C1", "C2", "native"]);
const LANG_CODE = /^[a-z]{2,3}$/;

/** A query string that is safe as a CLI argument (never a flag), or null. */
function queryText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.split(/\s+/).filter(Boolean).join(" ");
  return t && t.length <= 80 && !t.startsWith("-") ? t : null;
}

function parseFamilies(v: unknown): SearchFamily[] | null {
  if (!Array.isArray(v)) return null;
  const out: SearchFamily[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const f = item as Record<string, unknown>;
    const name = typeof f.name === "string" ? f.name.trim() : "";
    if (!name || name.length > 80) continue;
    const queries: ConfigQuery[] = [];
    for (const q of Array.isArray(f.queries) ? f.queries : []) {
      const text = queryText((q as Record<string, unknown>)?.text);
      const lang = typeof (q as Record<string, unknown>)?.lang === "string" ? ((q as Record<string, string>).lang).trim().toLowerCase() : "";
      if (text && LANG_CODE.test(lang)) queries.push({ text, lang });
    }
    const indeed = (Array.isArray(f.indeed) ? f.indeed : []).map(queryText).filter((t): t is string => t !== null);
    if (!queries.length && !indeed.length) continue;
    out.push({ name, queries, ...(indeed.length ? { indeed } : {}), ...(f.broad === true ? { broad: true } : {}) });
  }
  return out.length ? out : null;
}

function parseLanguages(v: unknown): ConfigLanguage[] | null {
  if (!Array.isArray(v)) return null;
  const out: ConfigLanguage[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const l = item as Record<string, unknown>;
    if (typeof l.language !== "string" || !l.language.trim()) continue;
    const level = (x: unknown): Cefr | null => {
      if (typeof x !== "string") return null;
      const t = x.trim();
      const norm = t.toLowerCase() === "native" ? "native" : t.toUpperCase();
      return CEFR.has(norm) ? (norm as Cefr) : null;
    };
    out.push({ language: l.language.trim(), read: level(l.read), write: level(l.write), speak: level(l.speak) });
  }
  return out;
}

export function profileConfigPath(root: string): string {
  return process.env.JOB_SEARCH_PROFILE_CONFIG || join(root, PROFILE_CONFIG_FILE);
}

export function parseProfileConfig(raw: unknown): ProfileConfig {
  const cfg: ProfileConfig = structuredClone(DEFAULT_PROFILE_CONFIG);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return cfg;
  const r = raw as Record<string, unknown>;
  if (typeof r.name === "string") cfg.name = r.name.trim();
  if (isMoney(r.current_salary_mxn)) cfg.current_salary_mxn = r.current_salary_mxn;
  if (isMoney(r.salary_floor_mxn)) cfg.salary_floor_mxn = r.salary_floor_mxn;
  const langs = parseLanguages(r.languages);
  if (langs) cfg.languages = langs;
  const search = r.search;
  if (search && typeof search === "object" && !Array.isArray(search)) {
    const fams = parseFamilies((search as Record<string, unknown>).families);
    if (fams) cfg.search.families = fams;
  }
  const s = r.skills;
  if (s && typeof s === "object" && !Array.isArray(s)) {
    const sk = s as Record<string, unknown>;
    if (isIds(sk.selected)) cfg.skills.selected = [...sk.selected];
    if (isIds(sk.combo_partners)) cfg.skills.combo_partners = [...sk.combo_partners];
    if (typeof sk.primary === "string" && sk.primary.trim()) cfg.skills.primary = sk.primary.trim();
  }
  return cfg;
}

export function loadProfileConfig(root: string): ProfileConfig {
  const path = profileConfigPath(root);
  if (!existsSync(path)) return structuredClone(DEFAULT_PROFILE_CONFIG);
  try {
    return parseProfileConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return structuredClone(DEFAULT_PROFILE_CONFIG);
  }
}

/** True once the user has put their own name in the file. */
export const isConfigFilled = (c: ProfileConfig): boolean => c.name !== "";
