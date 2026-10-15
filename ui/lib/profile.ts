import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Profile {
  ready: boolean;
  freshnessDays: number;
  salaryFloorMxn: number;
}

export const DEFAULT_FRESHNESS_DAYS = 4;
export const DEFAULT_SALARY_FLOOR_MXN = 30000;

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
  if (!existsSync(path)) return parseProfile("[YOUR_NAME]");
  return parseProfile(readFileSync(path, "utf8"));
}
