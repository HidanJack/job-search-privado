import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ageInDays } from "./jobs";
import { py } from "./onboarding";
import { PROFILE_CONFIG_FILE } from "./profile_config";
import {
  DISCOVER_DENY, DISCOVER_DIR_REL, DISCOVER_PERMISSION_MODE, DISCOVER_TOOLS, type PipelineStep, type Run,
} from "./runner";
import { loadDiscoverySettings } from "./search_settings";
import {
  PORTAL_PLANS, bunSweepSpawn, cleanTags, cliPath, isOpenToMexico, jobageArgs, parseRows, text, urlKey, type RawRow, type SweepSpawn,
} from "./sweep";

/**
 * Career-path discovery backend. The LLM step is the headless `/discover` run that writes
 * ui/state/discovery/proposals.json from input.txt; everything around it is deterministic:
 * the input builder and the proposal validator are Python tools (tools/discovery_*.py), the
 * market check below reuses the sweep's portal CLIs, region rule and window, and adding a path
 * to the search families goes through the validator tool (backup first, atomic write).
 */
export class DiscoveryError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export const discoveryDir = (root: string) => join(root, DISCOVER_DIR_REL);
const file = (root: string, name: string) => join(discoveryDir(root), name);
export const MAX_PROBE_PATHS = 8;
export const MAX_PROBE_QUERIES = 3;
export const MAX_SAMPLES = 5;
/** Keyword portals the market check uses: one page each, no Indeed (LLM-only, never swept without Claude). */
export const PROBE_PORTALS = ["himalayas", "jobicy", "remoteok", "getonbrd", "hn-hiring"] as const;

export interface ProposalQuery { text: string; lang: string }
export interface ProbePath { id: string; search_queries: ProposalQuery[] }
export interface MarketSample { title: string; company: string; portal: string; url: string }
export interface MarketEntry {
  /** Unique RELEVANT postings (title/tags contain the query's core terms), after the region and window filters. */
  vacancies: number;
  /** Unique postings the portals returned after the region and window filters, relevant or not. */
  raw_results: number;
  /** Relevant postings per portal. */
  by_portal: Record<string, number>;
  samples: MarketSample[];
  as_of: string;
  /** Days of postings the demand estimate covers (discovery.window_days, not the application window). */
  window_days: number;
  calls: number;
  failures: number;
  /** Working calls found nothing: the keyword has no visible demand on these portals. */
  no_demand_seen: boolean;
  /** Every call failed: the count is unknown, not zero. */
  unreachable: boolean;
}
export type MarketMap = Record<string, MarketEntry>;

// ---------------------------------------------------------------------------
// Market probe (no LLM)
// ---------------------------------------------------------------------------

/** At most `max` queries: English first, then one per other language before repeating a language. */
export function pickQueries(queries: ProposalQuery[], max = MAX_PROBE_QUERIES): ProposalQuery[] {
  const byLang = new Map<string, ProposalQuery[]>();
  for (const q of queries) {
    if (!byLang.has(q.lang)) byLang.set(q.lang, []);
    byLang.get(q.lang)!.push(q);
  }
  const langs = ["en", ...[...byLang.keys()].filter((l) => l !== "en")].filter((l) => byLang.has(l));
  const out: ProposalQuery[] = [];
  for (let round = 0; out.length < max; round++) {
    let any = false;
    for (const l of langs) {
      const q = byLang.get(l)![round];
      if (q && out.length < max) {
        out.push(q);
        any = true;
      }
    }
    if (!any) break;
  }
  return out;
}

/** The region flags of the sweep's LatAm variant for each portal (same machinery, one page). */
function probeArgs(portal: string): string[] {
  const plan = PORTAL_PLANS.find((p) => p.portal === portal);
  const variant = plan?.variants.find((v) => v.name.includes("latam")) ?? plan?.variants[0];
  return variant?.args ?? [];
}

// ---------------------------------------------------------------------------
// Relevance filter. Portals do fuzzy full-text search, so most rows a query returns are noise
// ("Infrastructure Engineer" for "document ai engineer"). A row counts only when its TITLE or
// TAGS (search results carry no descriptions) contain every CORE token of the query.
// ---------------------------------------------------------------------------

/** Role/seniority/modality words that say nothing about the topic. Dropped from a query to find its core. */
export const GENERIC_WORDS: readonly string[] = [
  "engineer", "engineers", "engineering", "developer", "developers", "development", "desarrollador", "desarrolladora",
  "ingeniero", "ingeniera", "programador", "programadora", "programmer", "remote", "remoto", "remota", "senior", "sr",
  "junior", "jr", "lead", "staff", "principal", "mid", "software", "backend", "frontend", "full", "stack", "fullstack",
  "especialista", "specialist", "hybrid", "latam", "worldwide", "job", "role",
];
const STOP_WORDS = new Set(["de", "del", "la", "el", "los", "las", "y", "e", "en", "con", "para", "un", "una", "a", "an", "and", "of", "for", "the", "in", "to", "with"]);
const GENERIC = new Set(GENERIC_WORDS);
/** Small, safe synonyms (whole word or phrase, accent-folded). Anything not listed must match literally. */
const ALIASES: Record<string, string[]> = {
  ai: ["ia"], ia: ["ai"], idp: ["intelligent document processing"], llm: ["llms"],
};

const foldText = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const words = (s: string) => foldText(s).split(/[^a-z0-9]+/).filter(Boolean);

/** Query tokens that carry the topic (accent-folded); empty when the query is only generic words. */
export function coreTokens(query: string): string[] {
  return words(query).filter((w) => !STOP_WORDS.has(w) && !GENERIC.has(w));
}

export function isRelevant(query: string, title: string, tags: string[] = []): boolean {
  const hay = words([title, ...tags].join(" "));
  const set = new Set(hay);
  const joined = ` ${hay.join(" ")} `;
  const has = (t: string) => set.has(t) || set.has(`${t}s`) || set.has(`${t}es`) || joined.includes(` ${t} `);
  const core = coreTokens(query);
  if (core.length === 0) {
    const phrase = words(query).filter((w) => !STOP_WORDS.has(w)).join(" ");
    return phrase !== "" && joined.includes(` ${phrase} `);
  }
  return core.every((t) => has(t) || (ALIASES[t] ?? []).some(has));
}

export interface ProbeOptions {
  root: string;
  maxDays: number;
  paths: ProbePath[];
  spawn?: SweepSpawn;
  concurrency?: number;
  timeoutMs?: number;
  pageSize?: number;
  today?: Date;
  bun?: string;
  log?: (line: string) => void;
}

interface ProbeTask { pathId: string; portal: string; query: string }

export async function probeMarket(o: ProbeOptions): Promise<MarketMap> {
  const spawn = o.spawn ?? bunSweepSpawn;
  const bun = o.bun ?? process.execPath;
  const today = o.today ?? new Date();
  const log = o.log ?? (() => {});
  const concurrency = Math.max(1, Math.min(3, o.concurrency ?? 3));
  const timeoutMs = o.timeoutMs ?? 45_000;
  const pageSize = Math.max(1, Math.min(100, o.pageSize ?? 50));
  const asOf = today.toISOString().slice(0, 10);

  const paths = o.paths.slice(0, MAX_PROBE_PATHS);
  const tasks: ProbeTask[] = [];
  for (const p of paths) {
    for (const q of pickQueries(p.search_queries)) for (const portal of PROBE_PORTALS) tasks.push({ pathId: p.id, portal, query: q.text });
  }
  const results: ({ rows: RawRow[] } | null)[] = tasks.map(() => null);

  async function call(task: ProbeTask): Promise<{ rows: RawRow[] } | null> {
    const argv = [
      bun, "run", cliPath(o.root, task.portal), "search", "-q", task.query, ...probeArgs(task.portal),
      ...jobageArgs(task.portal, o.maxDays), "--limit", String(pageSize), "--page", "1", "--format", "json",
    ];
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ctl.abort();
          reject(new Error("timeout"));
        }, timeoutMs);
      });
      const res = await Promise.race([spawn(argv, o.root, { signal: ctl.signal }), timeout]);
      const parsed = res.code === 0 ? parseRows(res.stdout) : null;
      if (!parsed) throw new Error(res.code === 0 ? "bad_output" : `exit_${res.code}`);
      return { rows: parsed.rows };
    } catch (err) {
      log(`Falló ${task.portal} · ${task.query}: ${(err as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await call(tasks[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, tasks.length)) }, worker));

  // Deterministic post-processing in task order.
  const market: MarketMap = {};
  const seen = new Map<string, Set<string>>();
  const seenRaw = new Map<string, Set<string>>();
  for (const p of paths) {
    market[p.id] = { vacancies: 0, raw_results: 0, by_portal: {}, samples: [], as_of: asOf, window_days: o.maxDays, calls: 0, failures: 0, no_demand_seen: false, unreachable: false };
    seen.set(p.id, new Set());
    seenRaw.set(p.id, new Set());
  }
  tasks.forEach((task, i) => {
    const entry = market[task.pathId];
    entry.calls++;
    const res = results[i];
    if (!res) {
      entry.failures++;
      return;
    }
    for (const row of res.rows) {
      const url = text(row.url);
      const title = text(row.title);
      if (!url || !title || !/^https?:\/\//.test(url)) continue;
      const key = urlKey(url);
      const known = seen.get(task.pathId)!;
      if (known.has(key)) continue;
      if (!isOpenToMexico(text(row.location))) continue;
      const date = typeof row.date === "string" && /^\d{4}-\d{2}-\d{2}/.test(row.date) ? row.date.slice(0, 10) : null;
      const age = ageInDays(date, today);
      if (age !== null && age > o.maxDays) continue;
      const raw = seenRaw.get(task.pathId)!;
      if (!raw.has(key)) {
        raw.add(key);
        entry.raw_results++;
      }
      if (!isRelevant(task.query, title, cleanTags(row.tags))) continue;
      known.add(key);
      entry.vacancies++;
      entry.by_portal[task.portal] = (entry.by_portal[task.portal] ?? 0) + 1;
      if (entry.samples.length < MAX_SAMPLES) entry.samples.push({ title: title.slice(0, 160), company: (text(row.company) ?? "(sin empresa)").slice(0, 80), portal: task.portal, url });
    }
  });
  for (const [id, entry] of Object.entries(market)) {
    entry.unreachable = entry.calls > 0 && entry.failures === entry.calls;
    entry.no_demand_seen = entry.calls > entry.failures && entry.vacancies === 0;
    log(`${id}: ${entry.vacancies} relevantes de ${entry.raw_results} (${entry.calls} consultas, ${entry.failures} fallidas)`);
  }
  return market;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function writeAtomic(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export const writeMarket = (root: string, market: MarketMap) => writeAtomic(file(root, "market.json"), JSON.stringify(market, null, 2) + "\n");
export const loadMarketFile = (root: string): MarketMap => readJson<MarketMap>(file(root, "market.json")) ?? {};

interface StoredProposal { version: number; generated: string; paths: any[]; skipped: any[]; warnings: string[] }
const loadStored = (root: string): StoredProposal | null => {
  const v = readJson<StoredProposal>(file(root, "proposals.json"));
  return v && Array.isArray(v.paths) ? v : null;
};

export interface DiscoveryState { probing: boolean }
export const newDiscoveryState = (): DiscoveryState => ({ probing: false });

/** Runs the market check on the stored proposals and writes market.json. */
export async function runProbe(root: string, state: DiscoveryState, log: (line: string) => void, spawn?: SweepSpawn, over: Partial<ProbeOptions> = {}): Promise<boolean> {
  const stored = loadStored(root);
  if (!stored) {
    log("No hay propuestas que comprobar.");
    return false;
  }
  const maxDays = loadDiscoverySettings(root).windowDays;
  log(`Comprobando el mercado real: últimos ${maxDays} días, ${PROBE_PORTALS.length} portales, hasta ${MAX_PROBE_QUERIES} búsquedas por camino.`);
  state.probing = true;
  try {
    const market = await probeMarket({ root, maxDays, paths: stored.paths, spawn, log, ...over });
    writeMarket(root, market);
    const all = Object.values(market);
    return all.length === 0 || all.some((m) => !m.unreachable);
  } finally {
    state.probing = false;
  }
}

// ---------------------------------------------------------------------------
// Run pipeline
// ---------------------------------------------------------------------------

export function describeErrors(errors: { path: string; message: string }[]): string {
  const shown = errors.slice(0, 5).map((e) => e.message);
  return shown.join(" ") + (errors.length > 5 ? ` (y ${errors.length - 5} más)` : "");
}

/** Builds input.txt and clears the previous proposals/market (the user's dismissals are kept). */
async function prepareInput(spawn: SweepSpawn, root: string, log: (line: string) => void): Promise<boolean> {
  for (const f of ["proposals.json", "market.json", "validation.json", "input.txt"]) rmSync(file(root, f), { force: true });
  const { code, json } = await py(spawn, "discovery_input.py", ["--root", root], root);
  if (code !== 0 || !json?.ok) {
    log("No se pudo preparar tu perfil para el análisis.");
    return false;
  }
  log(`Perfil preparado: ${json.jobs} vacantes mejor calificadas incluidas.`);
  return true;
}

async function validateOutput(spawn: SweepSpawn, root: string, log: (line: string) => void): Promise<boolean> {
  const path = file(root, "proposals.json");
  if (!existsSync(path)) {
    writeAtomic(file(root, "validation.json"), JSON.stringify({ errors: [{ path: "", message: "La IA no escribió ninguna propuesta." }] }));
    log("La IA no escribió las propuestas. Vuelve a intentarlo.");
    return false;
  }
  const { json } = await py(spawn, "discovery_proposal.py", ["validate", "--in", path, "--input", file(root, "input.txt"), "--root", root, "--out", path], root);
  if (!json || typeof json.ok !== "boolean") {
    writeAtomic(file(root, "validation.json"), JSON.stringify({ errors: [{ path: "", message: "No se pudo validar la propuesta." }] }));
    rmSync(path, { force: true });
    log("No se pudo validar la propuesta. Vuelve a intentarlo.");
    return false;
  }
  if (!json.ok) {
    writeAtomic(file(root, "validation.json"), JSON.stringify({ errors: json.errors }));
    rmSync(path, { force: true });
    log(`La propuesta no es válida: ${describeErrors(json.errors)} Vuelve a intentarlo.`);
    return false;
  }
  const n = json.proposal.paths.length;
  const dropped = Array.isArray(json.dropped) ? json.dropped.length : 0;
  log(`Propuesta lista: ${n} ${n === 1 ? "camino" : "caminos"}${dropped ? ` (${dropped} descartados por el validador)` : ""}.`);
  return true;
}

export function discoveryPipeline(root: string, toolSpawn: SweepSpawn, state: DiscoveryState, portalSpawn?: SweepSpawn): PipelineStep[] {
  return [
    { title: "Preparando tu perfil (sin IA)", task: (log) => prepareInput(toolSpawn, root, log) },
    {
      title: "Buscando caminos que encajen contigo (/discover)", prompt: "/discover", tools: DISCOVER_TOOLS,
      permissionMode: DISCOVER_PERMISSION_MODE, deny: DISCOVER_DENY,
    },
    { title: "Revisando la propuesta (sin IA)", task: (log) => validateOutput(toolSpawn, root, log) },
    { title: "Comprobando el mercado real (sin IA)", optional: true, task: (log) => runProbe(root, state, log, portalSpawn) },
  ];
}

// ---------------------------------------------------------------------------
// Status, proposals, dismiss, reset, add
// ---------------------------------------------------------------------------

export interface DiscoveryStatus {
  has_proposals: boolean;
  generated: string | null;
  run: Omit<Run, "events"> | null;
  probing: boolean;
  /** Errors of the last run when its proposal was rejected. */
  validation: { path: string; message: string }[] | null;
}

export function discoveryStatus(root: string, current: Run | null, state: DiscoveryState): DiscoveryStatus {
  const stored = loadStored(root);
  const run = current && current.kind === "discover" ? ({ ...current, events: undefined } as Omit<Run, "events">) : null;
  const validation = readJson<{ errors?: { path: string; message: string }[] }>(file(root, "validation.json"))?.errors ?? null;
  return {
    has_proposals: stored !== null, generated: stored && typeof stored.generated === "string" ? stored.generated : null,
    run, probing: state.probing, validation,
  };
}

const dismissedIds = (root: string): string[] => {
  const v = readJson<{ dismissed?: unknown }>(file(root, "state.json"));
  return Array.isArray(v?.dismissed) ? v!.dismissed.filter((x): x is string => typeof x === "string") : [];
};

/** Ids of the discovered paths already added as families (raw read of profile_config.json). */
export function addedIds(root: string): string[] {
  const cfg = readJson<{ search?: { families?: unknown } }>(join(root, PROFILE_CONFIG_FILE));
  const fams = cfg?.search?.families;
  const out: string[] = [];
  for (const f of Array.isArray(fams) ? fams : []) {
    const id = f && typeof f === "object" ? (f as Record<string, unknown>).source_path_id : null;
    if (typeof id === "string" && !out.includes(id)) out.push(id);
  }
  return out;
}

export function readProposals(root: string) {
  const stored = loadStored(root);
  if (!stored) throw new DiscoveryError(404, "no_proposals", "Todavía no hay propuestas. Ejecuta primero el descubrimiento.");
  const market = loadMarketFile(root);
  return {
    generated: stored.generated,
    paths: stored.paths.map((p) => ({ ...p, market: market[p.id] ?? null })),
    skipped: stored.skipped ?? [],
    warnings: stored.warnings ?? [],
    dismissed: dismissedIds(root),
    added: addedIds(root),
  };
}

function requireId(body: Record<string, unknown>): string {
  if (typeof body.id !== "string" || !body.id || body.id.length > 60) throw new DiscoveryError(400, "bad_request", "Falta el «id» del camino.");
  return body.id;
}

export function dismissPath(root: string, body: Record<string, unknown>): { ok: true; dismissed: string[] } {
  const id = requireId(body);
  const stored = loadStored(root);
  if (!stored) throw new DiscoveryError(404, "no_proposals", "Todavía no hay propuestas.");
  if (!stored.paths.some((p) => p.id === id)) throw new DiscoveryError(404, "path_not_found", "Ese camino no está en las propuestas.");
  const dismissed = dismissedIds(root);
  if (!dismissed.includes(id)) dismissed.push(id);
  writeAtomic(file(root, "state.json"), JSON.stringify({ dismissed }, null, 2) + "\n");
  return { ok: true, dismissed };
}

/** Removes the staged discovery files. Families already added to the search stay. */
export function resetDiscovery(root: string): void {
  rmSync(discoveryDir(root), { recursive: true, force: true });
}

const ADD_STATUS: Record<string, number> = {
  path_not_found: 404, no_proposals: 404, already_added: 409, config_missing: 409, config_invalid: 409,
  no_new_queries: 422, bad_queries: 400, invalid_family: 500,
};

export async function addPath(spawn: SweepSpawn, root: string, body: Record<string, unknown>) {
  const id = requireId(body);
  const args = ["add", "--root", root, "--proposal", file(root, "proposals.json"), "--id", id];
  if (body.queries !== undefined && body.queries !== null) {
    const q = body.queries;
    if (!Array.isArray(q) || q.length === 0 || q.length > 20 || q.some((x) => typeof x !== "string" && !(x && typeof x === "object" && typeof (x as Record<string, unknown>).text === "string"))) {
      throw new DiscoveryError(400, "bad_queries", "Las consultas elegidas deben ser una lista de textos (hasta 20).");
    }
    args.push("--queries", JSON.stringify(q));
  }
  if (!existsSync(file(root, "proposals.json"))) throw new DiscoveryError(404, "no_proposals", "Todavía no hay propuestas.");
  const { json } = await py(spawn, "discovery_proposal.py", args, root);
  if (!json) throw new DiscoveryError(500, "add_failed", "No se pudo agregar el camino (falló la herramienta).");
  if (!json.ok) throw new DiscoveryError(ADD_STATUS[json.error] ?? 500, String(json.error ?? "add_failed"), String(json.message ?? "No se pudo agregar el camino."));
  return json as { ok: true; family: { name: string; queries: ProposalQuery[] }; added_queries: number; duplicates: number; backup: string };
}
