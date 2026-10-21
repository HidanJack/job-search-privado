// Deterministic, LLM-free sweep over the five public portal CLIs. It builds a
// query matrix (English + Spanish keyword sets x location variants x pages),
// runs it with bounded concurrency, filters and dedupes the rows, and stores
// them through tools/scrape_state.py (source "cli") so /rank keeps working.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ageInDays, loadJobs } from "./jobs";
import { loadSearchSettings } from "./search_settings";
import { loadProfileConfig, type ConfigLanguage, type ProfileConfig, type SearchFamily } from "./profile_config";

// ---------------------------------------------------------------------------
// Query matrix
// ---------------------------------------------------------------------------

/** Keyword lists per language code ("en", "es", "de"...), built from the profile's search families. */
export type QuerySet = Record<string, string[]>;

export interface Variant {
  name: string;
  args: string[];
  /** Restrict this variant to some keyword languages (default: all of them). */
  langs?: string[];
}

export interface PortalPlan {
  portal: string;
  variants: Variant[];
  /** Keyword-less feeds (category / region browsing). */
  browse?: Variant[];
}

/** Terms that advertise "I speak this language" per language (name folded), used for the language-advantage family. */
const LANGUAGE_ADVANTAGE: Record<string, { code: string; queries: { text: string; lang: string }[] }> = {
  german: { code: "de", queries: [{ text: "german speaking", lang: "en" }, { text: "deutsch", lang: "de" }, { text: "dach", lang: "en" }] },
  deutsch: { code: "de", queries: [{ text: "german speaking", lang: "en" }, { text: "deutsch", lang: "de" }, { text: "dach", lang: "en" }] },
  aleman: { code: "de", queries: [{ text: "german speaking", lang: "en" }, { text: "deutsch", lang: "de" }, { text: "dach", lang: "en" }] },
  french: { code: "fr", queries: [{ text: "french speaking", lang: "en" }, { text: "français", lang: "fr" }] },
  frances: { code: "fr", queries: [{ text: "french speaking", lang: "en" }, { text: "français", lang: "fr" }] },
  portuguese: { code: "pt", queries: [{ text: "portuguese speaking", lang: "en" }, { text: "português", lang: "pt" }] },
  portugues: { code: "pt", queries: [{ text: "portuguese speaking", lang: "en" }, { text: "português", lang: "pt" }] },
  italian: { code: "it", queries: [{ text: "italian speaking", lang: "en" }, { text: "italiano", lang: "it" }] },
  italiano: { code: "it", queries: [{ text: "italian speaking", lang: "en" }, { text: "italiano", lang: "it" }] },
  dutch: { code: "nl", queries: [{ text: "dutch speaking", lang: "en" }, { text: "nederlands", lang: "nl" }] },
};
const LEVEL_RANK: Record<string, number> = { A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6, native: 6 };
const BASE_LANGS = new Set(["english", "ingles", "spanish", "espanol"]);

/** English/Spanish query-language names that never need an "advantage" search. */
const foldName = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

/**
 * Searches for a language the user works in besides English/Spanish (read or write at B1+),
 * e.g. "german speaking", "deutsch", "dach". Null when there is nothing to add.
 */
export function languageAdvantageFamily(languages: ConfigLanguage[]): SearchFamily | null {
  const queries: { text: string; lang: string }[] = [];
  for (const l of languages) {
    const name = foldName(l.language);
    if (!name || BASE_LANGS.has(name)) continue;
    const best = Math.max(LEVEL_RANK[l.read ?? ""] ?? 0, LEVEL_RANK[l.write ?? ""] ?? 0);
    if (best < LEVEL_RANK.B1) continue;
    queries.push(...(LANGUAGE_ADVANTAGE[name]?.queries ?? [{ text: `${name} speaking`, lang: "en" }]));
  }
  return queries.length ? { name: "Language advantage", queries } : null;
}

/** Flatten the families (plus the language-advantage family) into per-language keyword lists; en, es, then the rest. */
export function queriesFromConfig(cfg: Pick<ProfileConfig, "languages" | "search">): QuerySet {
  const families = [...cfg.search.families];
  const advantage = languageAdvantageFamily(cfg.languages);
  if (advantage) families.push(advantage);
  const byLang = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const fam of families) {
    for (const q of fam.queries) {
      const key = `${q.lang}\u0000${q.text.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!byLang.has(q.lang)) byLang.set(q.lang, []);
      byLang.get(q.lang)!.push(q.text);
    }
  }
  const out: QuerySet = {};
  for (const lang of ["en", "es", ...[...byLang.keys()].filter((l) => l !== "en" && l !== "es")]) {
    if (byLang.has(lang)) out[lang] = byLang.get(lang)!;
  }
  return out;
}

// "any-region" variants (Spanish keywords, no region flag) surface Spanish-language
// companies; their rows go through the same location filter as everything else, so
// only postings that accept Mexico/LatAm/worldwide survive.
export const PORTAL_PLANS: PortalPlan[] = [
  {
    portal: "getonbrd",
    variants: [
      { name: "latam", args: ["--latam"] },
      { name: "country-mx", args: ["--country", "MX"] },
    ],
    browse: [
      { name: "programming-mx", args: ["--category", "programming", "--country", "MX"] },
      { name: "programming-latam", args: ["--category", "programming", "--latam"] },
      { name: "data-mx", args: ["--category", "data-science-analytics", "--country", "MX"] },
      { name: "data-latam", args: ["--category", "data-science-analytics", "--latam"] },
    ],
  },
  {
    portal: "himalayas",
    variants: [
      { name: "country-mexico", args: ["--country", "Mexico"] },
      { name: "latam", args: ["--latam"] },
      { name: "any-region", args: [], langs: ["es"] },
    ],
    browse: [{ name: "feed-mexico", args: ["--country", "Mexico"] }],
  },
  { portal: "remoteok", variants: [{ name: "latam", args: ["--latam"] }] },
  {
    portal: "jobicy",
    variants: [
      { name: "geo-latam", args: ["--geo", "latam"] },
      { name: "geo-mexico", args: ["--geo", "mexico"] },
      { name: "any-region", args: [], langs: ["es"] },
    ],
    browse: [
      { name: "dev-mexico", args: ["--geo", "mexico", "--industry", "dev"] },
      { name: "dev-latam", args: ["--geo", "latam", "--industry", "dev"] },
      { name: "data-latam", args: ["--geo", "latam", "--industry", "data-science"] },
    ],
  },
  { portal: "hn-hiring", variants: [{ name: "latam", args: ["--latam"] }] },
];

export interface SweepTask {
  portal: string;
  /** null for keyword-less browse feeds. */
  query: string | null;
  variant: string;
  args: string[];
}

/** Portals are interleaved so concurrent workers spread across different hosts. */
export function buildTasks(plans: PortalPlan[], queries: QuerySet): SweepTask[] {
  const lists = plans.map((plan) => {
    const list: SweepTask[] = [];
    for (const lang of Object.keys(queries)) {
      for (const query of queries[lang]) {
        for (const v of plan.variants) {
          if (v.langs && !v.langs.includes(lang)) continue;
          list.push({ portal: plan.portal, query, variant: v.name, args: v.args });
        }
      }
    }
    for (const v of plan.browse ?? []) list.push({ portal: plan.portal, query: null, variant: v.name, args: v.args });
    return list;
  });
  const out: SweepTask[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

/** The task list a sweep would run for this repo's profile_config.json (no network). */
export function planSweep(root: string, portals: PortalPlan[] = PORTAL_PLANS): SweepTask[] {
  return buildTasks(portals, queriesFromConfig(loadProfileConfig(root)));
}

/** Human-readable plan for `ui/sweep.ts --dry-run`: a summary, then `portal | variant | query` per task. */
export function formatPlan(tasks: SweepTask[]): string {
  const perPortal = new Map<string, number>();
  for (const t of tasks) perPortal.set(t.portal, (perPortal.get(t.portal) ?? 0) + 1);
  const lines = [
    `Plan del barrido: ${tasks.length} tareas (${[...perPortal].map(([p, n]) => `${p} ${n}`).join(", ")}). No se hizo ninguna consulta.`,
    ...tasks.map((t) => `${t.portal} | ${t.variant} | ${t.query ?? "(sin palabra clave)"}`),
  ];
  return lines.join("\n");
}

export const MAX_SWEEP_DAYS = 90;

/** Every portal CLI documents the same client-side recency flag. */
export function jobageArgs(_portal: string, maxDays: number): string[] {
  const days = Math.min(MAX_SWEEP_DAYS, Math.max(1, Math.floor(maxDays)));
  return ["--jobage", String(days)];
}

// ---------------------------------------------------------------------------
// Location rule
// ---------------------------------------------------------------------------

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const OPEN = new RegExp(
  "mexico|cdmx|latam|latin america|latinoamerica|americas|worldwide|anywhere|global|in the world|" +
    "argentina|colombia|chile|peru|brazil|brasil|uruguay|ecuador|bolivia|venezuela|costa rica|panama|guatemala|" +
    "el salvador|honduras|nicaragua|dominican|paraguay|puerto rico",
);
const RESTRICTED = new RegExp(
  "\\b(spain|espana|madrid|barcelona|united states|usa|us|u\\.s\\.a?\\.?|uk|united kingdom|england|canada|europe|european|eu|emea|" +
    "germany|france|italy|portugal|netherlands|poland|ireland|romania|ukraine|india|philippines|australia|new zealand|" +
    "apac|asia|africa|singapore|japan|china)\\b",
);

/**
 * True unless the location text is restricted to non-LatAm places. A Spain or
 * Europe posting survives only when its text also names Mexico, LatAm or
 * worldwide/anywhere. Unknown or bare "Remote" locations are kept: /rank judges them.
 */
export function isOpenToMexico(location: string | null): boolean {
  const text = fold(location ?? "").trim();
  if (!text) return true;
  if (OPEN.test(text)) return true;
  return !RESTRICTED.test(text);
}

// ---------------------------------------------------------------------------
// Running the CLIs
// ---------------------------------------------------------------------------

export type SweepSpawn = (argv: string[], cwd: string, o: { signal: AbortSignal }) => Promise<{ code: number; stdout: string }>;

export const bunSweepSpawn: SweepSpawn = async (argv, cwd, { signal }) => {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const kill = () => proc.kill();
  signal.addEventListener("abort", kill, { once: true });
  try {
    const stdout = await new Response(proc.stdout).text();
    return { code: await proc.exited, stdout };
  } finally {
    signal.removeEventListener("abort", kill);
  }
};

export interface SweepPosting {
  title: string;
  company: string;
  url: string;
  posted_date: string | null;
  deadline: null;
  fit: "medium";
  status: "new";
  portal: string;
  source: "cli";
  location: string | null;
  /** Only present when the search row carried tags/category (never fetched separately). */
  tags?: string[];
  /** First ~400 characters of an excerpt/description, only when the search row already has one. */
  snippet?: string;
}

export const MAX_SNIPPET = 400;
const MAX_TAGS = 30;

/** Short, trimmed, de-duplicated tag strings from a search row (anything else is dropped). */
export function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of v) {
    if (typeof t !== "string") continue;
    const tag = t.replace(/\s+/g, " ").trim().slice(0, 60);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out.slice(0, MAX_TAGS);
}

export function cleanSnippet(row: { excerpt?: unknown; description?: unknown; snippet?: unknown }): string | null {
  for (const v of [row.snippet, row.excerpt, row.description]) {
    if (typeof v === "string" && v.trim()) return v.replace(/\s+/g, " ").trim().slice(0, MAX_SNIPPET);
  }
  return null;
}

export type SweepSaver = (postings: SweepPosting[]) => Promise<{ added: number; skipped: number }>;

/** Stores postings through tools/scrape_state.py (stdin), the one sanctioned write path. */
export function scrapeStateSaver(root: string): SweepSaver {
  return async (postings) => {
    const proc = Bun.spawn(["python3", "tools/scrape_state.py", "add"], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write(JSON.stringify(postings));
    await proc.stdin.end();
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if ((await proc.exited) !== 0) throw new Error(err.trim().slice(0, 300) || "scrape_state failed");
    const parsed = JSON.parse(out);
    return { added: Number(parsed.added) || 0, skipped: Number(parsed.skipped) || 0 };
  };
}

export interface SweepOptions {
  root: string;
  maxDays: number;
  maxPages?: number;
  pageSize?: number;
  concurrency?: number;
  timeoutMs?: number;
  spawn?: SweepSpawn;
  save?: SweepSaver;
  portals?: PortalPlan[];
  queries?: QuerySet;
  bun?: string;
  today?: Date;
  log?: (line: string) => void;
}

export interface PortalStats {
  calls: number;
  failures: number;
  raw: number;
  added: number;
}

export interface SweepStats {
  tasks: number;
  calls: number;
  failures: number;
  rawResults: number;
  duplicates: number;
  filteredLocation: number;
  filteredAge: number;
  kept: number;
  added: number;
  skipped: number;
  saveErrors: number;
  perPortal: Record<string, PortalStats>;
  perQuery: { portal: string; query: string; added: number }[];
}

interface RawRow {
  title?: unknown;
  company?: unknown;
  location?: unknown;
  date?: unknown;
  url?: unknown;
  tags?: unknown;
  excerpt?: unknown;
  description?: unknown;
  snippet?: unknown;
}

const cliPath = (root: string, portal: string) => join(root, ".agents", "skills", `${portal}-search`, "cli", "src", "cli.ts");
const urlKey = (url: string) => url.trim().replace(/\/+$/, "");
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

function parseRows(stdout: string): { rows: RawRow[]; total: number | null } | null {
  try {
    const v = JSON.parse(stdout);
    if (!Array.isArray(v?.results)) return null;
    return { rows: v.results, total: typeof v.meta?.total === "number" ? v.meta.total : null };
  } catch {
    return null;
  }
}

export async function runSweep(opts: SweepOptions): Promise<SweepStats> {
  const spawn = opts.spawn ?? bunSweepSpawn;
  const save = opts.save ?? scrapeStateSaver(opts.root);
  const bun = opts.bun ?? process.execPath;
  const maxPages = Math.max(1, opts.maxPages ?? 3);
  const pageSize = Math.max(1, Math.min(100, opts.pageSize ?? 50));
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const today = opts.today ?? new Date();
  const log = opts.log ?? (() => {});
  const tasks = buildTasks(opts.portals ?? PORTAL_PLANS, opts.queries ?? queriesFromConfig(loadProfileConfig(opts.root)));

  const stats: SweepStats = {
    tasks: tasks.length, calls: 0, failures: 0, rawResults: 0, duplicates: 0, filteredLocation: 0, filteredAge: 0,
    kept: 0, added: 0, skipped: 0, saveErrors: 0, perPortal: {}, perQuery: [],
  };
  const portalStats = (p: string) => (stats.perPortal[p] ??= { calls: 0, failures: 0, raw: 0, added: 0 });
  const taskRows: RawRow[][] = tasks.map(() => []);

  async function call(task: SweepTask, page: number): Promise<{ rows: RawRow[]; total: number | null } | null> {
    const argv = [
      bun, "run", cliPath(opts.root, task.portal), "search",
      ...(task.query ? ["-q", task.query] : []),
      ...task.args, ...jobageArgs(task.portal, opts.maxDays),
      "--limit", String(pageSize), "--page", String(page), "--format", "json",
    ];
    const ps = portalStats(task.portal);
    stats.calls++;
    ps.calls++;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ctl.abort();
          reject(new Error("timeout"));
        }, timeoutMs);
      });
      const res = await Promise.race([spawn(argv, opts.root, { signal: ctl.signal }), timeout]);
      const parsed = res.code === 0 ? parseRows(res.stdout) : null;
      if (!parsed) throw new Error(res.code === 0 ? "bad_output" : `exit_${res.code}`);
      return parsed;
    } catch (err) {
      stats.failures++;
      ps.failures++;
      log(`Falló ${task.portal} · ${task.query ?? task.variant} · ${task.variant} · p${page}: ${(err as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function runTask(index: number) {
    const task = tasks[index];
    const seen = new Set<string>();
    for (let page = 1; page <= maxPages; page++) {
      const res = await call(task, page);
      if (!res) return;
      let fresh = 0;
      for (const row of res.rows) {
        const key = typeof row.url === "string" ? urlKey(row.url) : "";
        if (!key || seen.has(key)) continue;
        seen.add(key);
        fresh++;
      }
      taskRows[index].push(...res.rows);
      const more = res.rows.length >= pageSize || (res.total !== null && res.total > page * pageSize);
      if (fresh === 0 || !more) return;
    }
  }

  let next = 0;
  let finished = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      await runTask(i);
      finished++;
      if (finished % 25 === 0 || finished === tasks.length) log(`Búsquedas completadas: ${finished}/${tasks.length} (${stats.calls} llamadas, ${stats.failures} fallidas)`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, tasks.length)) }, worker));

  // Deterministic post-processing in task order: filter, dedupe, group.
  const known = new Set<string>();
  const groups = new Map<string, { portal: string; query: string; postings: SweepPosting[] }>();
  tasks.forEach((task, i) => {
    for (const row of taskRows[i]) {
      stats.rawResults++;
      portalStats(task.portal).raw++;
      const url = text(row.url);
      const title = text(row.title);
      if (!url || !title || !/^https?:\/\//.test(url)) continue;
      const key = urlKey(url);
      if (known.has(key)) {
        stats.duplicates++;
        continue;
      }
      known.add(key);
      const location = text(row.location);
      if (!isOpenToMexico(location)) {
        stats.filteredLocation++;
        continue;
      }
      const date = typeof row.date === "string" && /^\d{4}-\d{2}-\d{2}/.test(row.date) ? row.date.slice(0, 10) : null;
      const age = ageInDays(date, today);
      if (age !== null && age > opts.maxDays) {
        stats.filteredAge++;
        continue;
      }
      const label = task.query ?? `[${task.variant}]`;
      const gid = `${task.portal}\u0000${label}`;
      let group = groups.get(gid);
      if (!group) groups.set(gid, (group = { portal: task.portal, query: label, postings: [] }));
      const tags = cleanTags(row.tags);
      const snippet = cleanSnippet(row);
      group.postings.push({
        title, company: text(row.company) ?? "(sin empresa)", url, posted_date: date, deadline: null, fit: "medium",
        status: "new", portal: task.portal, source: "cli", location: location ? location.slice(0, 200) : null,
        ...(tags.length ? { tags } : {}), ...(snippet ? { snippet } : {}),
      });
      stats.kept++;
    }
  });

  for (const group of groups.values()) {
    let added = 0;
    try {
      const res = await save(group.postings);
      added = res.added;
      stats.skipped += res.skipped;
    } catch (err) {
      stats.saveErrors++;
      log(`No se pudo guardar ${group.portal} · ${group.query}: ${(err as Error).message}`);
    }
    stats.added += added;
    portalStats(group.portal).added += added;
    stats.perQuery.push({ portal: group.portal, query: group.query, added });
  }
  log(
    `Barrido listo: ${stats.calls} llamadas (${stats.failures} fallidas), ${stats.rawResults} resultados, ` +
      `${stats.duplicates} repetidos, ${stats.filteredLocation} fuera de región, ${stats.filteredAge} muy antiguos, ${stats.added} nuevas.`,
  );
  for (const [portal, p] of Object.entries(stats.perPortal)) {
    log(`  ${portal}: ${p.calls} llamadas, ${p.failures} fallidas, ${p.raw} resultados, ${p.added} nuevas`);
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Last-sweep summary ("Cobertura")
// ---------------------------------------------------------------------------

export interface LastSweep {
  finishedAt: string;
  maxDays: number;
  calls: number;
  failures: number;
  added: number;
  /** null until the Indeed step ran (or when it was skipped). */
  indeedAdded: number | null;
  portals: number;
}

export const lastSweepPath = (root: string) => join(root, "ui", "state", "last_sweep.json");

export function writeLastSweep(root: string, last: LastSweep): void {
  const path = lastSweepPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(last, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export function readLastSweep(root: string): LastSweep | null {
  const path = lastSweepPath(root);
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v.calls === "number" && typeof v.added === "number" ? (v as LastSweep) : null;
  } catch {
    return null;
  }
}

export function coverageLine(last: LastSweep): string {
  const total = last.added + (last.indeedAdded ?? 0);
  const where = last.indeedAdded === null ? `${last.portals} portales` : `${last.portals} portales + Indeed`;
  return `Revisamos ${last.calls} búsquedas en ${where}: ${total} ${total === 1 ? "vacante nueva" : "vacantes nuevas"}.`;
}

export const PORTAL_COUNT = PORTAL_PLANS.length;

/** Sweep with the window from the saved settings; records the summary for the UI. */
export async function runConfiguredSweep(
  root: string,
  log: (line: string) => void,
  overrides: Partial<SweepOptions> = {},
): Promise<SweepStats> {
  const { maxDays } = loadSearchSettings(root);
  log(`Barrido de portales: últimos ${maxDays} días, ${PORTAL_COUNT} portales, inglés y español.`);
  const stats = await runSweep({ root, maxDays, log, ...overrides });
  writeLastSweep(root, {
    finishedAt: new Date().toISOString(), maxDays, calls: stats.calls, failures: stats.failures,
    added: stats.added, indeedAdded: null, portals: PORTAL_COUNT,
  });
  return stats;
}

export const countIndeed = (root: string): number =>
  loadJobs(root, new Date()).filter((j) => (j.portal ?? "").toLowerCase().startsWith("indeed")).length;

/** After the Indeed step: record how many Indeed postings it added and say so. */
export function finalizeCoverage(root: string, indeedBefore: number, log: (line: string) => void): LastSweep | null {
  const last = readLastSweep(root);
  if (!last) return null;
  const done = { ...last, indeedAdded: Math.max(0, countIndeed(root) - indeedBefore) };
  writeLastSweep(root, done);
  log(coverageLine(done));
  return done;
}
