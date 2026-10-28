import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Company blocklist ("lista negra"), TypeScript mirror of tools/company_blocklist.py.
 * Entries live in the gitignored profile_config.json under `blocked_companies`.
 * A company is blocked when its normalized name equals the normalized name or an alias of an
 * entry, or contains it as whole words. Blocked jobs are hidden, never deleted.
 */
export interface BlockedCompany {
  name: string;
  aliases: string[];
  reason?: string;
  /** YYYY-MM-DD; null for entries written by hand without it. */
  added: string | null;
}

export const MAX_ENTRIES = 200;
export const MAX_NAME = 80;
export const MAX_ALIASES = 10;
export const MAX_REASON = 200;
export const REASON_OUT = "Empresa en tu lista negra";
export const SUGGEST_MIN_POSTINGS = 8;
export const SUGGEST_MEDIAN_AGE_DAYS = 30;
const SUGGEST_REPOST_SHARE = 0.4;
const SUGGEST_MIN_REPOSTS = 3;

const SUFFIXES = [
  "s a p i de c v", "s a b de c v", "s a de c v", "s de r l de c v", "s de r l", "sa de cv", "sapi de cv",
  "s a p i", "s a", "sa", "inc", "llc", "ltd", "limited", "corp", "corporation", "gmbh", "co", "plc", "sas", "srl",
].sort((a, b) => b.split(" ").length - a.split(" ").length);

export function normalizeCompany(name: unknown): string {
  let t = String(name ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  t = t.replace(/[^0-9a-z\u0080-￿]+/g, " ").trim().replace(/\s+/g, " ");
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of SUFFIXES) {
      if (t.endsWith(" " + s) && t.length > s.length + 1) {
        t = t.slice(0, -s.length - 1).trimEnd();
        changed = true;
        break;
      }
    }
  }
  return t;
}

const namesOf = (e: BlockedCompany): string[] => [e.name, ...e.aliases].map(normalizeCompany).filter(Boolean);

export function findBlocked(company: unknown, entries: BlockedCompany[]): BlockedCompany | null {
  const c = normalizeCompany(company);
  if (!c || !entries.length) return null;
  const padded = ` ${c} `;
  for (const e of entries) for (const n of namesOf(e)) if (c === n || padded.includes(` ${n} `)) return e;
  return null;
}
export const isBlocked = (company: unknown, entries: BlockedCompany[]): boolean => findBlocked(company, entries) !== null;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const squash = (s: string) => s.trim().split(/\s+/).join(" ");

/** Valid entries only; duplicates by normalized name dropped. Never throws. */
export function parseBlockedCompanies(raw: unknown): BlockedCompany[] {
  if (!Array.isArray(raw)) return [];
  const out: BlockedCompany[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    const name = typeof r.name === "string" ? squash(r.name) : "";
    const key = normalizeCompany(name);
    if (!name || name.length > MAX_NAME || !key || seen.has(key)) continue;
    const aliases: string[] = [];
    for (const a of Array.isArray(r.aliases) ? r.aliases : []) {
      if (typeof a === "string" && a.trim() && a.trim().length <= MAX_NAME && !aliases.includes(squash(a))) aliases.push(squash(a));
    }
    const entry: BlockedCompany = { name, aliases: aliases.slice(0, MAX_ALIASES), added: typeof r.added === "string" && ISO.test(r.added) ? r.added : null };
    if (typeof r.reason === "string" && r.reason.trim()) entry.reason = squash(r.reason).slice(0, MAX_REASON);
    seen.add(key);
    out.push(entry);
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

export class BlocklistError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** Validates the body of POST /api/blocked-companies into a new entry. */
export function parseNewEntry(body: Record<string, unknown>, today: string): BlockedCompany {
  const name = typeof body.name === "string" ? squash(body.name) : "";
  if (!name) throw new BlocklistError(400, "invalid_name", "Escribe el nombre de la empresa.");
  if (name.length > MAX_NAME) throw new BlocklistError(400, "invalid_name", `El nombre no puede pasar de ${MAX_NAME} caracteres.`);
  if (!normalizeCompany(name)) throw new BlocklistError(400, "invalid_name", "El nombre no tiene letras ni números.");
  if (body.aliases !== undefined && (!Array.isArray(body.aliases) || body.aliases.some((a) => typeof a !== "string"))) {
    throw new BlocklistError(400, "invalid_aliases", "Los alias deben ser una lista de textos.");
  }
  if (body.reason !== undefined && body.reason !== null && typeof body.reason !== "string") {
    throw new BlocklistError(400, "invalid_reason", "La razón debe ser texto.");
  }
  const parsed = parseBlockedCompanies([{ name, aliases: body.aliases, reason: body.reason, added: today }]);
  return parsed[0];
}

type RawConfig = Record<string, unknown>;

/** Same file lib/profile_config.ts reads (not imported from there: it imports the parser below). */
const profileConfigPath = (root: string): string => process.env.JOB_SEARCH_PROFILE_CONFIG || join(root, "profile_config.json");

function readRaw(path: string): RawConfig {
  if (!existsSync(path)) return {};
  const v = JSON.parse(readFileSync(path, "utf8"));
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new BlocklistError(500, "config_invalid", "profile_config.json no es un objeto JSON.");
  return v as RawConfig;
}

const BACKUPS_TO_KEEP = 20;

/** Atomic write of profile_config.json with a timestamped backup of the previous file in ui/state/backups/. */
function writeConfig(root: string, doc: RawConfig): void {
  const path = profileConfigPath(root);
  if (existsSync(path)) {
    const dir = join(root, "ui", "state", "backups");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    copyFileSync(path, join(dir, `profile_config.${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
    const old = readdirSync(dir).filter((f) => f.startsWith("profile_config.") && f.endsWith(".json")).sort();
    for (const f of old.slice(0, Math.max(0, old.length - BACKUPS_TO_KEEP))) unlinkSync(join(dir, f));
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

export function readBlocked(root: string): BlockedCompany[] {
  try {
    return parseBlockedCompanies(readRaw(profileConfigPath(root)).blocked_companies);
  } catch {
    return [];
  }
}

export function addBlocked(root: string, entry: BlockedCompany): { entries: BlockedCompany[]; added: boolean } {
  const doc = readRaw(profileConfigPath(root));
  const entries = parseBlockedCompanies(doc.blocked_companies);
  if (entries.some((e) => normalizeCompany(e.name) === normalizeCompany(entry.name))) return { entries, added: false };
  if (entries.length >= MAX_ENTRIES) throw new BlocklistError(400, "too_many", `La lista negra admite hasta ${MAX_ENTRIES} empresas.`);
  const next = [...entries, entry];
  writeConfig(root, { ...doc, blocked_companies: next });
  return { entries: next, added: true };
}

export function removeBlocked(root: string, name: string): { entries: BlockedCompany[]; removed: boolean } {
  const doc = readRaw(profileConfigPath(root));
  const entries = parseBlockedCompanies(doc.blocked_companies);
  const key = normalizeCompany(name);
  const next = entries.filter((e) => normalizeCompany(e.name) !== key);
  if (next.length === entries.length) return { entries, removed: false };
  writeConfig(root, { ...doc, blocked_companies: next });
  return { entries: next, removed: true };
}

export interface CompanySuggestion {
  company: string;
  count: number;
  medianAgeDays: number | null;
  reposted: number;
  why: string;
}

interface Postingish {
  company: string;
  age_days: number | null;
  reposted?: boolean;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Companies with many stale or reposted postings (hints only; nothing is ever blocked automatically). */
export function suggestCompanies(jobs: Postingish[], blocked: BlockedCompany[]): CompanySuggestion[] {
  const groups = new Map<string, Postingish[]>();
  for (const j of jobs) {
    const key = normalizeCompany(j.company);
    if (key) groups.set(key, [...(groups.get(key) ?? []), j]);
  }
  const out: CompanySuggestion[] = [];
  for (const items of groups.values()) {
    if (items.length < SUGGEST_MIN_POSTINGS) continue;
    const names = new Map<string, number>();
    for (const i of items) names.set(i.company, (names.get(i.company) ?? 0) + 1);
    const company = [...names.entries()].sort((a, b) => b[1] - a[1])[0][0];
    if (findBlocked(company, blocked)) continue;
    const med = median(items.map((i) => i.age_days).filter((a): a is number => a !== null));
    const reposted = items.filter((i) => i.reposted === true).length;
    const stale = med !== null && med > SUGGEST_MEDIAN_AGE_DAYS;
    const manyReposts = reposted >= SUGGEST_MIN_REPOSTS && reposted / items.length >= SUGGEST_REPOST_SHARE;
    if (stale || manyReposts) out.push({ company, count: items.length, medianAgeDays: med, reposted, why: stale ? "vacantes muy viejas" : "vacantes republicadas" });
  }
  return out.sort((a, b) => b.count - a.count || a.company.localeCompare(b.company));
}
