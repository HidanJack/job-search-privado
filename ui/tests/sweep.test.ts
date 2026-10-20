import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PORTAL_PLANS, QUERIES, buildTasks, coverageLine, isOpenToMexico, jobageArgs, readLastSweep, runSweep, writeLastSweep,
  type PortalPlan, type SweepPosting, type SweepSpawn,
} from "../lib/sweep";

const TODAY = new Date("2026-10-16T12:00:00Z");

interface Row { id: string; title: string; company: string | null; location: string | null; date: string | null; url: string; tags?: unknown; excerpt?: unknown; description?: unknown }
const row = (n: number | string, over: Partial<Row> = {}): Row => ({
  id: String(n), title: `Python Dev ${n}`, company: `Co${n}`, location: "Remote (Mexico)", date: "2026-10-15T10:00:00.000Z",
  url: `https://example.com/jobs/${n}`, ...over,
});

const parse = (argv: string[]) => {
  const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const cli = argv.find((a) => a.includes("-search/cli")) ?? "";
  return {
    portal: /skills\/([a-z-]+)-search\//.exec(cli)?.[1] ?? "?",
    q: flag("-q"), page: Number(flag("--page")), limit: Number(flag("--limit")), jobage: flag("--jobage"), argv,
  };
};
const ok = (rows: Row[], total?: number) => ({ code: 0, stdout: JSON.stringify({ meta: { count: rows.length, page: 1, ...(total ? { total } : {}) }, results: rows }) });

const ONE: PortalPlan[] = [{ portal: "getonbrd", variants: [{ name: "latam", args: ["--latam"] }] }];

function base(spawn: SweepSpawn, over: Record<string, unknown> = {}) {
  const saved: SweepPosting[][] = [];
  const opts = {
    root: mkdtempSync(join(tmpdir(), "sweep-")), maxDays: 7, maxPages: 3, pageSize: 3, concurrency: 3, timeoutMs: 1000,
    spawn, today: TODAY, portals: ONE, queries: { en: ["python"], es: [] },
    save: async (p: SweepPosting[]) => { saved.push(p); return { added: p.length, skipped: 0 }; },
    ...over,
  };
  return { opts, saved };
}

describe("isOpenToMexico", () => {
  test("keeps Mexico, LatAm, worldwide and unknown locations", () => {
    for (const l of [null, "", "Remote", "Worldwide", "Remote (Worldwide)", "Anywhere", "Remote (Mexico)", "LATAM", "Latin America",
      "Americas", "Ciudad de México", "Guadalajara, Jalisco", "Argentina, Colombia", "Remote (Spain, Mexico)", "Spain, LATAM", "Remote - Anywhere in the world"]) {
      expect([l, isOpenToMexico(l)]).toEqual([l, true]);
    }
  });
  test("drops postings restricted to non-LatAm countries, Spain included", () => {
    for (const l of ["Remote (Spain)", "España", "Remote - USA", "Remote (US, Canada)", "United Kingdom", "Europe", "EMEA", "Germany, France", "Remote (US)"]) {
      expect([l, isOpenToMexico(l)]).toEqual([l, false]);
    }
  });
});

describe("matrix", () => {
  test("covers every family in English and Spanish on all five portals", () => {
    expect(PORTAL_PLANS.map((p) => p.portal).sort()).toEqual(["getonbrd", "himalayas", "hn-hiring", "jobicy", "remoteok"]);
    const all = [...QUERIES.en, ...QUERIES.es].join("|").toLowerCase();
    for (const term of ["python", "backend", "desarrollador python", "desarrollador backend", "ingeniero de datos", "data engineer", "analista de datos",
      "automatización", "rpa", "qa automation", "ai engineer", "llm", "ia", "fastapi", "django", "kubernetes", "rust", "etl", "desarrollador de software"]) {
      expect(all).toContain(term);
    }
  });
  test("Himalayas and Jobicy get an unrestricted-region variant for Spanish queries only", () => {
    const tasks = buildTasks(PORTAL_PLANS, QUERIES);
    for (const portal of ["himalayas", "jobicy"]) {
      const open = tasks.filter((t) => t.portal === portal && t.variant === "any-region");
      expect(open.length).toBe(QUERIES.es.length);
      expect(open.every((t) => QUERIES.es.includes(t.query!))).toBe(true);
      expect(open.every((t) => !t.args.includes("--latam") && !t.args.includes("--country") && !t.args.includes("--geo"))).toBe(true);
    }
  });
  test("tasks are interleaved across portals", () => {
    const tasks = buildTasks(PORTAL_PLANS, QUERIES);
    expect(new Set(tasks.slice(0, 5).map((t) => t.portal)).size).toBe(5);
  });
  test("maxDays maps to --jobage for every portal", () => {
    for (const p of PORTAL_PLANS) expect(jobageArgs(p.portal, 10)).toEqual(["--jobage", "10"]);
    expect(jobageArgs("getonbrd", 0)).toEqual(["--jobage", "1"]);
    expect(jobageArgs("getonbrd", 5000)).toEqual(["--jobage", "90"]);
  });
});

describe("runSweep", () => {
  test("passes maxDays as --jobage and the page size on every call", async () => {
    const seen: ReturnType<typeof parse>[] = [];
    const { opts } = base(async (argv) => { seen.push(parse(argv)); return ok([]); }, { maxDays: 10 });
    await runSweep(opts);
    expect(seen[0].jobage).toBe("10");
    expect(seen[0].limit).toBe(3);
    expect(seen[0].q).toBe("python");
  });

  test("paginates while pages are full, stops on a short page", async () => {
    const pages: number[] = [];
    const { opts } = base(async (argv) => {
      const { page } = parse(argv);
      pages.push(page);
      const start = (page - 1) * 3;
      return ok(page < 3 ? [1, 2, 3].map((i) => row(start + i)) : [row(7), row(8)]);
    });
    const stats = await runSweep(opts);
    expect(pages).toEqual([1, 2, 3]);
    expect(stats.rawResults).toBe(8);
    expect(stats.calls).toBe(3);
  });

  test("respects maxPages", async () => {
    const pages: number[] = [];
    const { opts } = base(async (argv) => {
      const { page } = parse(argv);
      pages.push(page);
      return ok([1, 2, 3].map((i) => row(page * 10 + i)));
    }, { maxPages: 2 });
    await runSweep(opts);
    expect(pages).toEqual([1, 2]);
  });

  test("stops when a page brings nothing new", async () => {
    const pages: number[] = [];
    const { opts } = base(async (argv) => { pages.push(parse(argv).page); return ok([row(1), row(2), row(3)]); });
    await runSweep(opts);
    expect(pages).toEqual([1, 2]);
  });

  test("a filtered short page continues when the portal reports more results", async () => {
    const pages: number[] = [];
    const { opts } = base(async (argv) => {
      const { page } = parse(argv);
      pages.push(page);
      return page === 1 ? ok([row(1)], 50) : ok([row(2)], 50);
    }, { maxPages: 2 });
    await runSweep(opts);
    expect(pages).toEqual([1, 2]);
  });

  test("failures, bad output and timeouts are skipped and counted, never thrown", async () => {
    const plans: PortalPlan[] = [
      { portal: "getonbrd", variants: [{ name: "a", args: [] }] },
      { portal: "himalayas", variants: [{ name: "b", args: [] }] },
      { portal: "remoteok", variants: [{ name: "c", args: [] }] },
      { portal: "jobicy", variants: [{ name: "d", args: [] }] },
      { portal: "hn-hiring", variants: [{ name: "e", args: [] }] },
    ];
    const { opts, saved } = base(async (argv, _cwd, o) => {
      const { portal } = parse(argv);
      if (portal === "getonbrd") throw new Error("boom");
      if (portal === "himalayas") return { code: 1, stdout: "" };
      if (portal === "remoteok") return { code: 0, stdout: "<html>" };
      if (portal === "jobicy") return new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(new Error("aborted"))));
      return ok([row(1)]);
    }, { portals: plans, timeoutMs: 30 });
    const stats = await runSweep(opts);
    expect(stats.calls).toBe(5);
    expect(stats.failures).toBe(4);
    expect(stats.perPortal["hn-hiring"].added).toBe(1);
    expect(saved.flat().length).toBe(1);
  });

  test("a hung spawner that ignores the abort signal still times out", async () => {
    const { opts } = base(() => new Promise(() => {}), { timeoutMs: 20 });
    const stats = await runSweep(opts);
    expect(stats.failures).toBe(1);
  });

  test("dedupes by URL across queries and saves once", async () => {
    const { opts, saved } = base(async () => ok([row(1), row(2)]), { queries: { en: ["python", "backend"], es: ["desarrollador python"] } });
    const stats = await runSweep(opts);
    expect(saved.flat().map((p) => p.url).sort()).toEqual(["https://example.com/jobs/1", "https://example.com/jobs/2"]);
    expect(stats.rawResults).toBe(6);
    expect(stats.duplicates).toBe(4);
    expect(stats.added).toBe(2);
  });

  test("drops Spain-only and other non-LatAm postings, keeps worldwide and Spain+Mexico", async () => {
    const { opts, saved } = base(async () => ok([
      row(1, { location: "Remote (Spain)" }), row(2, { location: "Worldwide" }), row(3, { location: "Remote (Spain, Mexico)" }),
    ]));
    const stats = await runSweep(opts);
    expect(saved.flat().map((p) => p.url)).toEqual(["https://example.com/jobs/2", "https://example.com/jobs/3"]);
    expect(stats.filteredLocation).toBe(1);
  });

  test("drops postings older than maxDays but keeps undated ones", async () => {
    const { opts, saved } = base(async () => ok([
      row(1, { date: "2026-10-01T00:00:00.000Z" }), row(2, { date: null }), row(3),
    ]));
    const stats = await runSweep(opts);
    expect(saved.flat().map((p) => p.url)).toEqual(["https://example.com/jobs/2", "https://example.com/jobs/3"]);
    expect(stats.filteredAge).toBe(1);
  });

  test("maps rows to scrape_state postings", async () => {
    const { opts, saved } = base(async () => ok([row(1, { company: null })]));
    await runSweep(opts);
    expect(saved[0][0]).toEqual({
      title: "Python Dev 1", company: "(sin empresa)", url: "https://example.com/jobs/1", posted_date: "2026-10-15",
      deadline: null, fit: "medium", status: "new", portal: "getonbrd", source: "cli", location: "Remote (Mexico)",
    });
  });

  test("persists tags and a 400-char snippet when the search row carries them", async () => {
    const long = "x".repeat(900);
    const { opts, saved } = base(async () => ok([
      row(1, { tags: ["Python", " Data Engineering ", "", 7, "python"], excerpt: "  Build   pipelines  " }),
      row(2, { tags: [], description: long }),
      row(3),
    ]));
    await runSweep(opts);
    const byUrl = Object.fromEntries(saved.flat().map((p) => [p.url, p]));
    expect(byUrl["https://example.com/jobs/1"].tags).toEqual(["Python", "Data Engineering"]);
    expect(byUrl["https://example.com/jobs/1"].snippet).toBe("Build pipelines");
    expect(byUrl["https://example.com/jobs/2"].snippet).toHaveLength(400);
    expect("tags" in byUrl["https://example.com/jobs/2"]).toBe(false);
    expect("tags" in byUrl["https://example.com/jobs/3"]).toBe(false);
    expect("snippet" in byUrl["https://example.com/jobs/3"]).toBe(false);
  });

  test("runs at most `concurrency` calls at once", async () => {
    let live = 0;
    let peak = 0;
    const { opts } = base(async () => {
      live++; peak = Math.max(peak, live);
      await Bun.sleep(5);
      live--;
      return ok([]);
    }, { queries: { en: ["a", "b", "c", "d", "e", "f", "g", "h"], es: [] } });
    await runSweep(opts);
    expect(peak).toBe(3);
  });

  test("reports new jobs per portal and per query from the save results", async () => {
    const { opts } = base(async (argv) => ok([row(`${parse(argv).q}-1`)]), {
      queries: { en: ["python", "backend"], es: [] },
      save: async (p: SweepPosting[]) => ({ added: p.length - 1 + (p[0].title.includes("python") ? 1 : 0), skipped: 0 }),
    });
    const stats = await runSweep(opts);
    expect(stats.perQuery.map((q) => [q.query, q.added])).toEqual([["python", 1], ["backend", 0]]);
    expect(stats.perPortal.getonbrd.added).toBe(1);
  });

  test("a failing save is recorded without throwing", async () => {
    const { opts } = base(async () => ok([row(1)]), { save: async () => { throw new Error("python missing"); } });
    const stats = await runSweep(opts);
    expect(stats.saveErrors).toBe(1);
    expect(stats.added).toBe(0);
  });
});

describe("last sweep file and coverage line", () => {
  test("round-trips and builds the Spanish coverage sentence", () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-last-"));
    expect(readLastSweep(root)).toBeNull();
    writeLastSweep(root, { finishedAt: "2026-10-16T10:00:00Z", maxDays: 7, calls: 312, failures: 4, added: 18, indeedAdded: 5, portals: 5 });
    const last = readLastSweep(root)!;
    expect(last.calls).toBe(312);
    expect(coverageLine(last)).toBe("Revisamos 312 búsquedas en 5 portales + Indeed: 23 vacantes nuevas.");
    expect(coverageLine({ ...last, indeedAdded: null })).toBe("Revisamos 312 búsquedas en 5 portales: 18 vacantes nuevas.");
    expect(coverageLine({ ...last, added: 1, indeedAdded: 0 })).toBe("Revisamos 312 búsquedas en 5 portales + Indeed: 1 vacante nueva.");
  });
});
