import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../server";
import { GENERIC_WORDS, MAX_PROBE_PATHS, MAX_PROBE_QUERIES, PROBE_PORTALS, coreTokens, isRelevant, pickQueries, probeMarket } from "../lib/discovery";
import { DISCOVER_DENY, DISCOVER_TOOLS, buildArgv, type SpawnedProcess, type Spawner } from "../lib/runner";
import { planSweep, queriesFromConfig, type SweepSpawn } from "../lib/sweep";
import { loadProfileConfig } from "../lib/profile_config";

const BASE = "http://127.0.0.1:8787";
const HOST = { Host: "127.0.0.1:8787" };
const ORIGIN = { ...HOST, Origin: BASE };
const JSON_H = { ...ORIGIN, "Content-Type": "application/json" };
const TODAY = new Date("2026-10-21T12:00:00Z");

type H = ReturnType<typeof createHandler>;
const get = (h: H, path: string) => h.handle(new Request(BASE + path, { headers: HOST }));
const post = (h: H, path: string, body?: unknown, headers: Record<string, string> = JSON_H) =>
  h.handle(new Request(BASE + path, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) }));

// ---------------------------------------------------------------------------
// Fake portal CLI
// ---------------------------------------------------------------------------

interface Row { id: string; title: string; company: string | null; location: string | null; date: string | null; url: string }
const row = (n: number | string, over: Partial<Row> = {}): Row => ({
  id: String(n), title: `Document AI Role ${n}`, company: `Co${n}`, location: "Remote (Mexico)", date: "2026-10-20T10:00:00.000Z",
  url: `https://example.com/jobs/${n}`, ...over,
});
const ok = (rows: Row[]) => ({ code: 0, stdout: JSON.stringify({ meta: { count: rows.length, page: 1 }, results: rows }) });
const parse = (argv: string[]) => {
  const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const cli = argv.find((a) => a.includes("-search/cli")) ?? "";
  return { portal: /skills\/([a-z-]+)-search\//.exec(cli)?.[1] ?? "?", q: flag("-q") ?? "", page: flag("--page"), jobage: flag("--jobage"), argv };
};

const PATHS = (n = 1, queries: { text: string; lang: string }[] = [{ text: "document ai engineer", lang: "en" }]) =>
  Array.from({ length: n }, (_, i) => ({ id: `path-${i + 1}`, search_queries: queries }));

const opts = (spawn: SweepSpawn, over: Record<string, unknown> = {}) => ({
  root: mkdtempSync(join(tmpdir(), "disc-probe-")), maxDays: 7, spawn, today: TODAY, timeoutMs: 1000, concurrency: 3, bun: "bun", ...over,
});

describe("pickQueries", () => {
  test("at most 3, English first, then one per other language before repeating a language", () => {
    const q = [
      { text: "a", lang: "es" }, { text: "b", lang: "en" }, { text: "c", lang: "en" }, { text: "d", lang: "de" }, { text: "e", lang: "en" },
    ];
    expect(pickQueries(q).map((x) => x.text)).toEqual(["b", "a", "d"]);
    expect(pickQueries(q.slice(1, 3)).map((x) => x.text)).toEqual(["b", "c"]);
    expect(pickQueries([])).toEqual([]);
  });
  test("budget constants", () => {
    expect(MAX_PROBE_QUERIES).toBe(3);
    expect(MAX_PROBE_PATHS).toBe(8);
    expect([...PROBE_PORTALS]).toEqual(["himalayas", "jobicy", "remoteok", "getonbrd", "hn-hiring"]);
  });
});

describe("relevance filter", () => {
  test("core tokens drop generic role words and keep the topic", () => {
    expect(coreTokens("remote document AI engineer")).toEqual(["document", "ai"]);
    expect(coreTokens("Ingeniero de visión computacional")).toEqual(["vision", "computacional"]);
    expect(coreTokens("backend engineer")).toEqual([]);
    expect(GENERIC_WORDS).toContain("engineer");
    expect(GENERIC_WORDS).toContain("desarrollador");
  });
  test("all core tokens must appear in the title or the tags (accent-folded, whole words)", () => {
    expect(isRelevant("document ai engineer", "Senior Document AI Engineer", [])).toBe(true);
    expect(isRelevant("document ai engineer", "Infrastructure Engineer", [])).toBe(false);
    expect(isRelevant("document ai engineer", "Software Engineer", ["Document", "AI"])).toBe(true);
    expect(isRelevant("computer vision engineer", "Computer-Vision Engineer", [])).toBe(true);
    expect(isRelevant("computer vision engineer", "Computer Scientist", [])).toBe(false);
    expect(isRelevant("ingeniero de visión", "Ingeniero de Vision Artificial", [])).toBe(true);
    expect(isRelevant("entity resolution", "Entity Resolution Engineer", [])).toBe(true);
    expect(isRelevant("entity resolution", "Operations Analyst (Finance)", [])).toBe(false);
  });
  test("whole words only: 'ai' does not match 'maintain' or 'chain'", () => {
    expect(isRelevant("ai engineer", "Supply Chain Engineer", [])).toBe(false);
    expect(isRelevant("ai engineer", "AI Engineers", [])).toBe(true); // simple plural
  });
  test("a query with no core token left requires the whole phrase", () => {
    expect(isRelevant("backend engineer", "Backend Engineer II", [])).toBe(true);
    expect(isRelevant("backend engineer", "Infrastructure Engineer", [])).toBe(false);
    expect(isRelevant("backend engineer", "Engineer, Backend", [])).toBe(false);
  });
  test("small documented aliases: ai/ia, idp, ocr", () => {
    expect(isRelevant("ia documental", "Document AI Engineer", [])).toBe(false); // documental has no alias
    expect(isRelevant("ingeniero de ia", "AI Engineer", [])).toBe(true);
    expect(isRelevant("idp engineer", "Intelligent Document Processing Engineer", [])).toBe(true);
  });
});

describe("probeMarket", () => {
  test("noise is not counted: only title/tag matches are relevant, raw results are kept", async () => {
    const spawn: SweepSpawn = async (argv) => parse(argv).portal === "himalayas"
      ? ok([row(1), row(2, { title: "Infrastructure Engineer" }), row(3, { title: "Operations Analyst", ...({ tags: ["document", "ai"] } as object) }), row(4, { title: "Linux Support Engineer" })])
      : ok([]);
    const m = await probeMarket({ ...opts(spawn), paths: PATHS(1) });
    expect(m["path-1"].raw_results).toBe(4);
    expect(m["path-1"].vacancies).toBe(2);
    expect(m["path-1"].by_portal).toEqual({ himalayas: 2 });
    expect(m["path-1"].samples.map((s: { title: string }) => s.title)).toEqual(["Document AI Role 1", "Operations Analyst"]);
    expect(m["path-1"].no_demand_seen).toBe(false);
  });

  test("raw results with nothing relevant means no demand seen", async () => {
    const spawn: SweepSpawn = async () => ok([row(1, { title: "Infrastructure Engineer" })]);
    const m = await probeMarket({ ...opts(spawn), paths: PATHS(1) });
    expect(m["path-1"]).toMatchObject({ vacancies: 0, no_demand_seen: true, unreachable: false });
    expect(m["path-1"].raw_results).toBe(1);
    expect(m["path-1"].samples).toEqual([]);
  });

  test("a posting is relevant to the query that returned it", async () => {
    const spawn: SweepSpawn = async (argv) => parse(argv).portal === "himalayas" && parse(argv).q === "rpa developer" ? ok([row(1, { title: "RPA Developer" })]) : ok([]);
    const m = await probeMarket({ ...opts(spawn), paths: PATHS(1, [{ text: "document ai engineer", lang: "en" }, { text: "rpa developer", lang: "en" }]) });
    expect(m["path-1"].vacancies).toBe(1);
  });

  test("one page per portal and query, never Indeed, with the sweep's region flags and the user's window", async () => {
    const seen: ReturnType<typeof parse>[] = [];
    const spawn: SweepSpawn = async (argv) => { seen.push(parse(argv)); return ok([]); };
    await probeMarket({ ...opts(spawn, { maxDays: 14 }), paths: PATHS(1) });
    expect(seen.length).toBe(5);
    expect(new Set(seen.map((s) => s.portal))).toEqual(new Set(PROBE_PORTALS));
    expect(seen.every((s) => s.page === "1" && s.jobage === "14" && s.q === "document ai engineer")).toBe(true);
    expect(seen.some((s) => s.argv.some((a) => a.toLowerCase().includes("indeed")))).toBe(false);
    const byPortal = Object.fromEntries(seen.map((s) => [s.portal, s.argv]));
    expect(byPortal.getonbrd).toContain("--latam");
    expect(byPortal.jobicy).toContain("latam");
    expect(byPortal.himalayas).toContain("--latam");
  });

  test("counts unique vacancies per path, de-duplicating across queries and portals, with per-portal counts", async () => {
    const spawn: SweepSpawn = async (argv) => {
      const { portal, q } = parse(argv);
      if (portal === "himalayas") return ok([row(1), row(2)]);
      if (portal === "getonbrd") return ok([row(2), row(3)]); // 2 repeats himalayas
      if (portal === "remoteok" && q === "ai document") return ok([row(1), row(4)]);
      return ok([]);
    };
    const m = await probeMarket({ ...opts(spawn), paths: PATHS(1, [{ text: "document ai", lang: "en" }, { text: "ai document", lang: "en" }]) });
    expect(m["path-1"].vacancies).toBe(4);
    expect(m["path-1"].by_portal).toEqual({ himalayas: 2, getonbrd: 1, remoteok: 1 });
    expect(m["path-1"].calls).toBe(10);
    expect(m["path-1"].failures).toBe(0);
    expect(m["path-1"].no_demand_seen).toBe(false);
    expect(m["path-1"].as_of).toBe("2026-10-21");
  });

  test("keeps at most 5 samples with title, company, portal and url", async () => {
    const spawn: SweepSpawn = async (argv) => (parse(argv).portal === "himalayas" ? ok(Array.from({ length: 9 }, (_, i) => row(i + 1))) : ok([]));
    const m = await probeMarket({ ...opts(spawn), paths: PATHS(1) });
    expect(m["path-1"].vacancies).toBe(9);
    expect(m["path-1"].samples.length).toBe(5);
    expect(m["path-1"].samples[0]).toEqual({ title: "Document AI Role 1", company: "Co1", portal: "himalayas", url: "https://example.com/jobs/1" });
  });

  test("drops postings restricted to non-LatAm countries and postings older than the window", async () => {
    const spawn: SweepSpawn = async (argv) => parse(argv).portal === "himalayas"
      ? ok([row(1), row(2, { location: "Remote (US only)" }), row(3, { location: "Germany" }), row(4, { date: "2026-09-01T00:00:00Z" }), row(5, { location: "Worldwide" }), row(6, { date: null })])
      : ok([]);
    const m = await probeMarket({ ...opts(spawn), paths: PATHS(1) });
    expect(m["path-1"].samples.map((s: { title: string }) => s.title)).toEqual(["Document AI Role 1", "Document AI Role 5", "Document AI Role 6"]);
    expect(m["path-1"].vacancies).toBe(3);
  });

  test("the title-language and language gates are not applied", async () => {
    const spawn: SweepSpawn = async (argv) => parse(argv).portal === "jobicy" ? ok([row(1, { title: "Softwareentwickler (m/w/d) Python" })]) : ok([]);
    const m = await probeMarket({ ...opts(spawn), paths: PATHS(1, [{ text: "python", lang: "en" }]) });
    expect(m["path-1"].vacancies).toBe(1);
  });

  test("failures (exit code, bad JSON, timeout) are counted and skipped; the rest still counts", async () => {
    const spawn: SweepSpawn = async (argv) => {
      const { portal } = parse(argv);
      if (portal === "himalayas") return { code: 1, stdout: "" };
      if (portal === "jobicy") return { code: 0, stdout: "not json" };
      if (portal === "remoteok") return new Promise(() => {}); // never answers
      if (portal === "getonbrd") return ok([row(1)]);
      return ok([]);
    };
    const logs: string[] = [];
    const m = await probeMarket({ ...opts(spawn, { timeoutMs: 30, log: (l: string) => logs.push(l) }), paths: PATHS(1) });
    expect(m["path-1"].calls).toBe(5);
    expect(m["path-1"].failures).toBe(3);
    expect(m["path-1"].vacancies).toBe(1);
    expect(logs.some((l) => l.includes("remoteok"))).toBe(true);
  });

  test("0 vacancies with working calls means no demand seen; all calls failing means unknown, not zero demand", async () => {
    const none = await probeMarket({ ...opts(async () => ok([])), paths: PATHS(1) });
    expect(none["path-1"]).toMatchObject({ vacancies: 0, no_demand_seen: true, failures: 0 });
    const down = await probeMarket({ ...opts(async () => ({ code: 1, stdout: "" })), paths: PATHS(1) });
    expect(down["path-1"]).toMatchObject({ vacancies: 0, no_demand_seen: false, failures: 5, unreachable: true });
  });

  test("polite: at most 8 paths and 3 queries each, concurrency never above 3", async () => {
    let active = 0;
    let peak = 0;
    let calls = 0;
    const spawn: SweepSpawn = async () => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(3);
      active--;
      return ok([]);
    };
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `p${i}`, search_queries: ["a", "b", "c", "d", "e"].map((t) => ({ text: `${t} ${i}`, lang: "en" })),
    }));
    const m = await probeMarket({ ...opts(spawn), paths: many });
    expect(Object.keys(m).length).toBe(8);
    expect(calls).toBe(8 * 3 * 5);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  test("paths are independent: the same posting counts for each path that finds it", async () => {
    const spawn: SweepSpawn = async (argv) => (parse(argv).portal === "himalayas" ? ok([row(1)]) : ok([]));
    const m = await probeMarket({ ...opts(spawn), paths: PATHS(2) });
    expect(m["path-1"].vacancies).toBe(1);
    expect(m["path-2"].vacancies).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const PROFILE_MD = `---
framework_version: 1.1.3
---

# Candidate Profile

## Identity
- **Name:** Alex Example

## Evidence bank: ML and computer vision
- **Parser Lab** - extracts tables from bank statement PDFs.
- **Ledger Match** - reconciliation engine rewritten in Rust (PyO3).
`;

function tempRoot(withConfig = true): string {
  const root = mkdtempSync(join(tmpdir(), "disc-"));
  mkdirSync(join(root, ".claude/skills/job-application-assistant"), { recursive: true });
  writeFileSync(join(root, ".claude/skills/job-application-assistant/01-candidate-profile.md"), PROFILE_MD);
  writeFileSync(join(root, "CLAUDE.md"), "# Job Application Assistant for Alex Example\n\n## Candidate Profile\n- **Name:** Alex Example\n\n## Repo Structure\n- cv/\n");
  mkdirSync(join(root, "job_scraper"));
  cpSync(join(import.meta.dir, "fixtures", "seen_jobs.json"), join(root, "job_scraper", "seen_jobs.json"));
  if (withConfig) {
    writeFileSync(join(root, "profile_config.json"), JSON.stringify({
      name: "Alex Example", candidate_years: 4,
      languages: [{ language: "English", read: "B2", write: "B2", speak: "A2" }],
      search: { families: [{ name: "Python backend", queries: [{ text: "python backend developer", lang: "en" }] }] },
    }, null, 2));
  }
  return root;
}

const dir = (root: string, name = "") => join(root, "ui", "state", "discovery", name);

const PROPOSAL = {
  version: 1, generated: "2026-10-21",
  paths: [
    {
      id: "document-ai-engineer", title: "Document AI engineer", summary: "Extract data from documents.",
      why_it_fits: [
        { claim: "Built a PDF table extractor", evidence: "Parser Lab - extracts tables from bank statement PDFs" },
        { claim: "Rust work", evidence: "reconciliation engine rewritten in Rust" },
        { claim: "Invented Kafka work", evidence: "Kafka cluster at Imaginary Corp" },
      ],
      gaps: ["No LLM evaluation experience"], seniority_fit: "mid", adjacent_to: ["Python backend"],
      search_queries: [{ text: "document ai engineer", lang: "en" }, { text: "ingeniero de ia documental", lang: "es" }, { text: "python backend developer", lang: "en" }],
      confidence: "high", inferred: true,
    },
    {
      id: "rpa-developer", title: "RPA developer", summary: "Automate back-office work.",
      why_it_fits: [{ claim: "ETL pipelines", evidence: "Parser Lab - extracts tables" }],
      gaps: ["No UiPath"], seniority_fit: "any", adjacent_to: [],
      search_queries: [{ text: "rpa developer", lang: "en" }], confidence: "medium", inferred: true,
    },
  ],
  skipped: [], warnings: [],
};

const RESULT = JSON.stringify({ type: "result", result: "Listo.", is_error: false, total_cost_usd: 0.1234 });

function fakeClaude(root: string, calls: string[][], write: ((root: string) => void) | null = (r) => {
  writeFileSync(join(r, "ui/state/discovery/proposals.json"), JSON.stringify(PROPOSAL));
}, code = 0): Spawner {
  return (argv): SpawnedProcess => {
    calls.push(argv);
    write?.(root);
    return { stdout: new Response(RESULT + "\n").body!, exited: Promise.resolve(code), kill() {} };
  };
}

/** Portal CLIs: himalayas knows 2 vacancies for any query, the rest none. */
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString();
const portals: SweepSpawn = async (argv) => {
  const { portal, q } = parse(argv);
  return portal === "himalayas" ? ok([row(1, { date: yesterday(), title: `${q} ${1}` }), row(2, { date: yesterday(), title: `${q} ${2}` })]) : ok([]);
};

async function waitDone(h: H, id: string) {
  for (let i = 0; i < 600; i++) {
    const run = h.runs.current;
    if (run && run.id === id && run.status !== "running") return run;
    await Bun.sleep(10);
  }
  throw new Error("run did not finish");
}

async function runDiscovery(root: string, claude = fakeClaude(root, [])) {
  const h = createHandler({ root, spawner: claude, sweepSpawn: portals });
  const res = await post(h, "/api/discovery/run");
  expect(res.status).toBe(200);
  const { id } = await res.json();
  const run = await waitDone(h, id);
  return { h, run };
}

describe("the headless /discover run is sandboxed", () => {
  test("dontAsk, only its own directory, no shell/web/agents", () => {
    const argv = buildArgv("claude", "/discover", DISCOVER_TOOLS, "sonnet", { permissionMode: "dontAsk", deny: DISCOVER_DENY });
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(argv.slice(argv.indexOf("--allowedTools") + 1)).toEqual(["Read(ui/state/discovery/*)", "Edit(ui/state/discovery/*)"]);
    const deny = argv.slice(argv.indexOf("--disallowedTools") + 1, argv.indexOf("--allowedTools"));
    for (const t of ["Bash", "WebFetch", "WebSearch", "Agent"]) expect(deny).toContain(t);
    expect(deny).not.toContain("Edit");
    expect(argv[2]).toBe("/discover");
  });
});

describe("GET /api/discovery/status", () => {
  test("fresh repo: nothing yet", async () => {
    const h = createHandler({ root: tempRoot() });
    expect(await (await get(h, "/api/discovery/status")).json()).toMatchObject({ has_proposals: false, generated: null, run: null, probing: false });
  });
  test("host and method guards", async () => {
    const h = createHandler({ root: tempRoot() });
    expect((await h.handle(new Request(BASE + "/api/discovery/status", { headers: { Host: "evil.example" } }))).status).toBe(403);
    expect((await h.handle(new Request(BASE + "/api/discovery/status", { method: "DELETE", headers: ORIGIN }))).status).toBe(405);
    expect((await get(h, "/api/discovery/nope")).status).toBe(404);
  });
});

describe("POST /api/discovery/run", () => {
  test("builds the input, runs /discover sandboxed, validates, probes the market, reports cost", async () => {
    const root = tempRoot();
    const calls: string[][] = [];
    const { h, run } = await runDiscovery(root, fakeClaude(root, calls));
    expect(run.status).toBe("done");
    expect(run.kind).toBe("discover");

    const input = readFileSync(dir(root, "input.txt"), "utf8");
    expect(input).toMatch(/^NONCE: [0-9a-f]{16}\nTODAY: \d{4}-\d{2}-\d{2}\n/);
    expect(input).toContain("Parser Lab");
    expect(input).toContain("Backend Python Engineer"); // best ranked job of the fixture

    expect(calls.length).toBe(1);
    const argv = calls[0];
    expect(argv[2]).toBe("/discover");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(argv.slice(argv.indexOf("--allowedTools") + 1)).toEqual(DISCOVER_TOOLS);
    expect(argv).toContain("--disallowedTools");
    expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
    expect(run.events.some((e) => e.type === "cost" && e.text.includes("0.12"))).toBe(true);

    const status = await (await get(h, "/api/discovery/status")).json();
    expect(status).toMatchObject({ has_proposals: true, generated: "2026-10-21", probing: false });

    const res = await (await get(h, "/api/discovery/proposals")).json();
    expect(res.paths.map((p: { id: string }) => p.id)).toEqual(["document-ai-engineer", "rpa-developer"]);
    const first = res.paths[0];
    expect(first.why_it_fits.length).toBe(2); // the fabricated Kafka evidence was dropped
    expect(first.confidence).toBe("medium"); // and the confidence capped
    expect(first.search_queries.map((q: { text: string }) => q.text)).toEqual(["document ai engineer", "ingeniero de ia documental"]); // known query removed
    expect(first.market.vacancies).toBe(2);
    expect(first.market.by_portal).toEqual({ himalayas: 2 });
    expect(res.paths[1].market).toMatchObject({ vacancies: 2 });
    expect(res.warnings.some((w: string) => w.includes("Kafka"))).toBe(true);
    expect(res.dismissed).toEqual([]);
    expect(res.added).toEqual([]);
  });

  test("an invalid proposal fails the run in Spanish and leaves no proposals", async () => {
    const root = tempRoot();
    const { h, run } = await runDiscovery(root, fakeClaude(root, [], (r) => writeFileSync(join(r, "ui/state/discovery/proposals.json"), "{}")));
    expect(run.status).toBe("failed");
    const status = await (await get(h, "/api/discovery/status")).json();
    expect(status.has_proposals).toBe(false);
    expect(status.validation.length).toBeGreaterThan(0);
    expect((await get(h, "/api/discovery/proposals")).status).toBe(404);
  });

  test("Claude writing nothing fails cleanly; a failed market probe does not discard the proposals", async () => {
    const root = tempRoot();
    const { run } = await runDiscovery(root, fakeClaude(root, [], null));
    expect(run.status).toBe("failed");

    const root2 = tempRoot();
    const h = createHandler({ root: root2, spawner: fakeClaude(root2, []), sweepSpawn: async () => ({ code: 1, stdout: "" }) });
    const { id } = await (await post(h, "/api/discovery/run")).json();
    await waitDone(h, id);
    const res = await (await get(h, "/api/discovery/proposals")).json();
    expect(res.paths.length).toBe(2);
    expect(res.paths[0].market).toMatchObject({ vacancies: 0, no_demand_seen: false, unreachable: true });
  });

  test("a stale proposal is removed when a new run starts", async () => {
    const root = tempRoot();
    await runDiscovery(root);
    const { run } = await runDiscovery(root, fakeClaude(root, [], null));
    expect(run.status).toBe("failed");
    expect(existsSync(dir(root, "proposals.json"))).toBe(false);
    expect(existsSync(dir(root, "market.json"))).toBe(false);
  });

  test("busy: a second run while one is running gets 409; origin guard", async () => {
    const root = tempRoot();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const slow: Spawner = () => ({
      stdout: new ReadableStream<Uint8Array>({
        async start(c) {
          await gate;
          c.enqueue(new TextEncoder().encode(RESULT + "\n"));
          c.close();
        },
      }),
      exited: gate.then(() => 0), kill() {},
    });
    const h = createHandler({ root, spawner: slow, sweepSpawn: portals });
    const first = await post(h, "/api/discovery/run");
    expect(first.status).toBe(200);
    const second = await post(h, "/api/discovery/run");
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe("busy");
    expect((await post(h, "/api/discovery/reset")).status).toBe(409);
    expect((await post(h, "/api/discovery/run", undefined, HOST)).status).toBe(403);
    release();
  });

  test("the model comes from JOB_UI_MODEL", async () => {
    const root = tempRoot();
    const prev = process.env.JOB_UI_MODEL;
    process.env.JOB_UI_MODEL = "opus";
    try {
      const calls: string[][] = [];
      await runDiscovery(root, fakeClaude(root, calls));
      expect(calls[0][calls[0].indexOf("--model") + 1]).toBe("opus");
    } finally {
      if (prev === undefined) delete process.env.JOB_UI_MODEL;
      else process.env.JOB_UI_MODEL = prev;
    }
  });
});

describe("add / dismiss / reset", () => {
  test("add writes a discovered family to profile_config.json with a backup, and the sweep picks it up", async () => {
    const root = tempRoot();
    const { h } = await runDiscovery(root);
    const before = readFileSync(join(root, "profile_config.json"), "utf8");
    const res = await post(h, "/api/discovery/add", { id: "document-ai-engineer" });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.ok).toBe(true);
    expect(out.family.name).toBe("Descubierto: Document AI engineer");
    expect(out.added_queries).toBe(2);
    expect(out.backup).toContain("ui/state/backups/");
    expect(readFileSync(join(root, out.backup), "utf8")).toBe(before);

    const cfg = JSON.parse(readFileSync(join(root, "profile_config.json"), "utf8"));
    const fam = cfg.search.families.at(-1);
    expect(fam).toMatchObject({ name: "Descubierto: Document AI engineer", discovered: true, source_path_id: "document-ai-engineer" });
    expect(cfg.search.families.length).toBe(2);

    const loaded = loadProfileConfig(root);
    expect(loaded.search.families.at(-1)).toMatchObject({ discovered: true, source_path_id: "document-ai-engineer" });
    expect(queriesFromConfig(loaded).en).toContain("document ai engineer");
    expect(queriesFromConfig(loaded).es).toContain("ingeniero de ia documental");
    const tasks = planSweep(root);
    expect(tasks.some((t) => t.query === "document ai engineer" && t.portal === "himalayas")).toBe(true);
    expect(tasks.some((t) => t.query === "ingeniero de ia documental")).toBe(true);

    const props = await (await get(h, "/api/discovery/proposals")).json();
    expect(props.added).toEqual(["document-ai-engineer"]);
    expect((await post(h, "/api/discovery/add", { id: "document-ai-engineer" })).status).toBe(409); // already added
  });

  test("add with a subset of queries; unknown queries and unknown ids are refused and write nothing", async () => {
    const root = tempRoot();
    const { h } = await runDiscovery(root);
    const before = readFileSync(join(root, "profile_config.json"), "utf8");
    expect((await post(h, "/api/discovery/add", { id: "document-ai-engineer", queries: ["something else"] })).status).toBe(400);
    expect((await post(h, "/api/discovery/add", { id: "nope" })).status).toBe(404);
    expect((await post(h, "/api/discovery/add", { id: 5 })).status).toBe(400);
    expect((await post(h, "/api/discovery/add", { id: "document-ai-engineer", queries: "x" })).status).toBe(400);
    expect(readFileSync(join(root, "profile_config.json"), "utf8")).toBe(before);
    const ok1 = await post(h, "/api/discovery/add", { id: "document-ai-engineer", queries: [{ text: "ingeniero de ia documental", lang: "es" }] });
    expect(ok1.status).toBe(200);
    const cfg = JSON.parse(readFileSync(join(root, "profile_config.json"), "utf8"));
    expect(cfg.search.families.at(-1).queries).toEqual([{ text: "ingeniero de ia documental", lang: "es" }]);
  });

  test("add refuses to write when profile_config.json is missing (and never creates it)", async () => {
    const root = tempRoot(false);
    const { h } = await runDiscovery(root);
    const res = await post(h, "/api/discovery/add", { id: "document-ai-engineer" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("config_missing");
    expect(existsSync(join(root, "profile_config.json"))).toBe(false);
  });

  test("add needs the Origin header and the Spanish JSON error shape", async () => {
    const root = tempRoot();
    const { h } = await runDiscovery(root);
    expect((await post(h, "/api/discovery/add", { id: "document-ai-engineer" }, { ...HOST, "Content-Type": "application/json" })).status).toBe(403);
    const bad = await post(h, "/api/discovery/add", { id: "nope" });
    const body = await bad.json();
    expect(body.error).toBe("path_not_found");
    expect(body.message).toMatch(/camino/);
  });

  test("dismiss hides a path (idempotent) and reset clears the discovery state but keeps added families", async () => {
    const root = tempRoot();
    const { h } = await runDiscovery(root);
    expect((await post(h, "/api/discovery/dismiss", { id: "rpa-developer" })).status).toBe(200);
    expect((await post(h, "/api/discovery/dismiss", { id: "rpa-developer" })).status).toBe(200);
    expect((await post(h, "/api/discovery/dismiss", { id: "nope" })).status).toBe(404);
    expect((await post(h, "/api/discovery/dismiss", {})).status).toBe(400);
    let props = await (await get(h, "/api/discovery/proposals")).json();
    expect(props.dismissed).toEqual(["rpa-developer"]);
    expect(props.paths.length).toBe(2); // the UI decides how to show dismissed ones

    await post(h, "/api/discovery/add", { id: "document-ai-engineer" });
    expect((await post(h, "/api/discovery/reset")).status).toBe(200);
    expect(existsSync(dir(root))).toBe(false);
    expect((await get(h, "/api/discovery/proposals")).status).toBe(404);
    expect(loadProfileConfig(root).search.families.length).toBe(2); // added family stays
    expect(await (await get(h, "/api/discovery/status")).json()).toMatchObject({ has_proposals: false });
  });

  test("a new run keeps what the user dismissed", async () => {
    const root = tempRoot();
    const { h } = await runDiscovery(root);
    await post(h, "/api/discovery/dismiss", { id: "rpa-developer" });
    const again = await post(h, "/api/discovery/run");
    await waitDone(h, (await again.json()).id);
    expect((await (await get(h, "/api/discovery/proposals")).json()).dismissed).toEqual(["rpa-developer"]);
  });
});

describe("POST /api/discovery/probe", () => {
  test("re-runs only the market check on the stored proposals", async () => {
    const root = tempRoot();
    const { h } = await runDiscovery(root);
    const res = await post(h, "/api/discovery/probe");
    expect(res.status).toBe(200);
    await waitDone(h, (await res.json()).id);
    expect(h.runs.current?.status).toBe("done");
    expect(h.runs.current?.kind).toBe("discover");
    const nothing = tempRoot();
    const h2 = createHandler({ root: nothing });
    expect((await post(h2, "/api/discovery/probe")).status).toBe(404);
  });
});
