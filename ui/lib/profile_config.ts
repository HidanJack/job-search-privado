import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-user numbers and skill selection from the gitignored `profile_config.json`
 * at the repo root (schema: README, profile_config.example.json). Mirrors
 * tools/profile_config.py: a missing file, bad JSON or an invalid value falls
 * back to these neutral defaults key by key and never throws.
 */
export interface ProfileConfig {
  name: string;
  current_salary_mxn: number;
  salary_floor_mxn: number;
  skills: { selected: string[]; combo_partners: string[]; primary: string };
}

export const DEFAULT_PROFILE_CONFIG: ProfileConfig = {
  name: "",
  current_salary_mxn: 20000,
  salary_floor_mxn: 30000,
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
