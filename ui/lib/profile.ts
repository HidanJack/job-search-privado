import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PROFILE_CONFIG, isConfigFilled, loadProfileConfig } from "./profile_config";

export interface Profile {
  ready: boolean;
  freshnessDays: number;
  salaryFloorMxn: number;
  /** Name from profile_config.json (header of the page); empty until the user fills the file in. */
  name?: string;
  /** profile_config.json exists and has the user's name. */
  configured?: boolean;
}

export const DEFAULT_FRESHNESS_DAYS = 4;
export const DEFAULT_SALARY_FLOOR_MXN = DEFAULT_PROFILE_CONFIG.salary_floor_mxn;

/** Reads the dashboard defaults from CLAUDE.md's Identity block. */
export function parseProfile(text: string): Profile {
  const freshness = /\*\*Freshness window:\*\*\s*(\d+)/i.exec(text);
  const floor = /\*\*Salary floor:\*\*\s*([\d][\d,.\s]*)/i.exec(text);
  const floorValue = floor ? Number(floor[1].replace(/[,\s]/g, "")) : NaN;
  return {
    ready: !text.includes("[YOUR_NAME]"),
    freshnessDays: freshness ? Number(freshness[1]) : DEFAULT_FRESHNESS_DAYS,
    salaryFloorMxn: Number.isFinite(floorValue) && floorValue > 0 ? floorValue : DEFAULT_SALARY_FLOOR_MXN,
  };
}

export function loadProfile(root: string): Profile {
  const path = join(root, "CLAUDE.md");
  const profile = existsSync(path) ? parseProfile(readFileSync(path, "utf8")) : parseProfile("[YOUR_NAME]");
  const config = loadProfileConfig(root);
  return { ...profile, name: config.name, configured: isConfigFilled(config) };
}
