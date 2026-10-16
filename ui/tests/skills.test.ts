import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../server";
import type { Spawner } from "../lib/runner";
import {
  DEFAULT_FX, PORTALS, SKILLS, addJob, aggregate, aggregatePath, buildSummary, classifyGroup, groupStats, isRelevant, isStale,
  loadAggregate, monthlyMxn, parseSalaryString, percentile, rawDir, readFx, sampleAll, toRawJob, type CliSpawner, type RawJob,
} from "../lib/skills";

const BASE = "http://127.0.0.1:8787";
const ORIGIN = { Origin: BASE, Host: "127.0.0.1:8787", "Content-Type": "application/json" };
const tempRoot = () => mkdtempSync(join(tmpdir(), "job-ui-skills-"));
const def = (id: string) => SKILLS.find((s) => s.id === id)!;
const variant = { name: "t", args: [], openToMx: false, paged: true };

function job(over: Partial<RawJob> = {}): RawJob {
  return {
    key: `x:${Math.random()}`, portal: "x", id: "1", title: "Python Developer", company: null, location: "Remote (anywhere)",
    url: null, remote: true, tags: [], salary: null, salary_min: 2000, salary_max: 3000, salary_currency: "USD",
    salary_period: "month", open_to_mx: false, via: ["t"], ...over,
  };
}

describe("salary conversion", () => {
  test("USD/month uses the midpoint and the FX table", () => {
    expect(monthlyMxn(job(), DEFAULT_FX)).toEqual({ ok: true, mxn: 2500 * 18.5, hourly: false });
  });
  test("annual is divided by 12, EUR uses its own rate", () => {
    const r = monthlyMxn(job({ salary_min: 60000, salary_max: 60000, salary_currency: "EUR", salary_period: "year" }), DEFAULT_FX);
    expect(r).toEqual({ ok: true, mxn: 5000 * 20, hourly: false });
  });
  test("hourly is x160 and flagged", () => {
    expect(monthlyMxn(job({ salary_min: 30, salary_max: 50, salary_period: "hour" }), DEFAULT_FX)).toEqual({ ok: true, mxn: 40 * 160 * 18.5, hourly: true });
  });
  test("single-sided ranges use the known side", () => {
    const r = monthlyMxn(job({ salary_min: null, salary_max: 4000 }), DEFAULT_FX);
    expect(r).toEqual({ ok: true, mxn: 4000 * 18.5, hourly: false });
  });
  test("noise below 8,000 and above 600,000 MXN/month is discarded", () => {
    expect(monthlyMxn(job({ salary_min: 51, salary_max: 51, salary_currency: "MXN" }), DEFAULT_FX)).toEqual({ ok: false, reason: "noise_low" });
    expect(monthlyMxn(job({ salary_min: 1850, salary_max: 1850, salary_currency: "MXN" }), DEFAULT_FX)).toEqual({ ok: false, reason: "noise_low" });
    expect(monthlyMxn(job({ salary_min: 450000, salary_max: 500000, salary_period: "month" }), DEFAULT_FX)).toEqual({ ok: false, reason: "noise_high" });
  });
  test("missing, unknown currency and missing period are reported separately", () => {
    expect(monthlyMxn(job({ salary_min: null, salary_max: null }), DEFAULT_FX)).toEqual({ ok: false, reason: "no_salary" });
    expect(monthlyMxn(job({ salary_currency: "XYZ" }), DEFAULT_FX)).toEqual({ ok: false, reason: "unknown_currency" });
    expect(monthlyMxn(job({ salary_period: null }), DEFAULT_FX)).toEqual({ ok: false, reason: "no_period" });
  });
  test("falls back to the string form for CLIs without numeric fields", () => {
    expect(parseSalaryString("USD 2000–3000/month")).toEqual({ min: 2000, max: 3000, currency: "USD", period: "month" });
    expect(parseSalaryString("EUR 60000/year")).toEqual({ min: 60000, max: 60000, currency: "EUR", period: "year" });
    expect(parseSalaryString("competitive")).toBeNull();
    const r = monthlyMxn(job({ salary: "USD 2000–3000/month", salary_min: null, salary_max: null, salary_currency: null, salary_period: null }), DEFAULT_FX);
    expect(r.ok && r.mxn).toBe(2500 * 18.5);
  });
});

describe("FX from CLAUDE.md", () => {
  test("merges CLAUDE.md rates over the defaults and ignores the comment", () => {
    const root = tempRoot();
    writeFileSync(join(root, "CLAUDE.md"), "- **FX to MXN:** USD=17.9, GBP=22 <!-- CODE=rate, comma-separated -->\n");
    const { fx, source } = readFx(root);
    expect(source).toBe("CLAUDE.md");
    expect(fx.USD).toBe(17.9);
    expect(fx.GBP).toBe(22);
    expect(fx.EUR).toBe(20);
  });
  test("defaults when absent", () => {
    expect(readFx(tempRoot())).toEqual({ fx: DEFAULT_FX, source: "default" });
  });
});

describe("relevance filter", () => {
  test("skill or synonym must be in title or tags", () => {
    expect(isRelevant(job({ title: "Senior Python Engineer" }), def("python"))).toBe(true);
    expect(isRelevant(job({ title: "Backend Engineer", tags: ["Python", "AWS"] }), def("python"))).toBe(true);
    expect(isRelevant(job({ title: "Backend Engineer", tags: ["Programming"] }), def("python"))).toBe(false);
    expect(isRelevant(job({ title: "Platform engineer (K8s)" }), def("kubernetes"))).toBe(true);
    expect(isRelevant(job({ title: "Pythonista designer" }), def("python"))).toBe(false);
    expect(isRelevant(job({ title: "Trusted Rustic Bakery" }), def("rust"))).toBe(false);
    expect(isRelevant(job({ title: "Retrieval-Augmented Generation engineer" }), def("rag"))).toBe(true);
    expect(isRelevant(job({ title: "Rust developer" }), def("rust_python"))).toBe(false);
    expect(isRelevant(job({ title: "Rust and Python developer" }), def("rust_python"))).toBe(true);
    expect(isRelevant(job({ title: "Ingeniero de datos" }), def("data_engineer"))).toBe(true);
  });
});

describe("relevance: strict on every portal", () => {
  const gob = (over: Partial<RawJob> = {}) => job({ portal: "getonbrd", title: "Backend Developer", tags: ["Programming"], queries: ["python"], ...over });
  test("a portal query match alone is not enough (getonbrd and himalayas)", () => {
    expect(isRelevant(gob(), def("python"))).toBe(false);
    expect(isRelevant(gob({ portal: "himalayas" }), def("python"))).toBe(false);
    expect(isRelevant(gob({ title: "Java Developer / ETL", tags: ["Java", "ETL"] }), def("python"))).toBe(false);
  });
  test("real tags or title match is accepted, synonyms included", () => {
    expect(isRelevant(gob({ tags: ["Python", "AWS"] }), def("python"))).toBe(true);
    expect(isRelevant(gob({ portal: "himalayas", tags: ["Rust Developer"] }), def("rust"))).toBe(true);
    expect(isRelevant(gob({ tags: ["K8s"] }), def("kubernetes"))).toBe(true);
    expect(isRelevant(gob({ title: "Python Developer" }), def("python"))).toBe(true);
  });
  test("jobicy and AND-combo skills (rust_python) stay strict", () => {
    expect(isRelevant(gob({ portal: "jobicy" }), def("python"))).toBe(false);
    expect(isRelevant(gob({ portal: "jobicy", title: "Python Developer" }), def("python"))).toBe(true);
    expect(isRelevant(gob({ queries: ["rust python"], title: "Backend Developer" }), def("rust_python"))).toBe(false);
  });
  test("queries are recorded and merged across sightings", () => {
    const a = toRawJob("getonbrd", { id: "1", title: "x" }, variant, "python")!;
    const b = toRawJob("getonbrd", { id: "1", title: "x" }, variant, "rust")!;
    const m = new Map<string, RawJob>();
    addJob(m, a);
    addJob(m, b);
    expect(m.get(a.key)!.queries).toEqual(["python", "rust"]);
  });
});

describe("group classification", () => {
  test("Mexico alone is mx; Mexico plus others is remote_intl", () => {
    expect(classifyGroup({ location: "Remote (Mexico only)", open_to_mx: false })).toBe("mx");
    expect(classifyGroup({ location: "Ciudad de México (hybrid)", open_to_mx: false })).toBe("mx");
    expect(classifyGroup({ location: "CDMX", open_to_mx: false })).toBe("mx");
    expect(classifyGroup({ location: "Remote (Mexico, Colombia)", open_to_mx: true })).toBe("remote_intl");
  });
  test("other Latin American countries are latam_local, even from a LatAm filter", () => {
    expect(classifyGroup({ location: "Remote (Chile only)", open_to_mx: false })).toBe("latam_local");
    expect(classifyGroup({ location: "Bogotá, Colombia", open_to_mx: false })).toBe("latam_local");
    expect(classifyGroup({ location: "Peru (hybrid)", open_to_mx: true })).toBe("latam_local");
  });
  test("anywhere / LatAm / a Mexico-filtered query is remote_intl; the rest is unclassified", () => {
    expect(classifyGroup({ location: "Remote (anywhere)", open_to_mx: false })).toBe("remote_intl");
    expect(classifyGroup({ location: "LATAM", open_to_mx: false })).toBe("remote_intl");
    expect(classifyGroup({ location: "Remote (worldwide)", open_to_mx: false })).toBe("remote_intl");
    expect(classifyGroup({ location: "Remote", open_to_mx: true })).toBe("remote_intl");
    expect(classifyGroup({ location: "USA", open_to_mx: false })).toBeNull();
    expect(classifyGroup({ location: null, open_to_mx: false })).toBeNull();
  });
});

describe("percentiles", () => {
  test("linear interpolation", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([10, 20, 30, 40], 0.25)).toBe(17.5);
    expect(percentile([10, 20, 30, 40], 0.75)).toBe(32.5);
  });
  test("fewer than 8 values is insufficient: no percentiles, range kept", () => {
    const s = groupStats([30000, 20000, 25000]);
    expect(s).toMatchObject({ n: 3, insufficient: true, p25: null, median: null, p75: null, min: 20000, max: 30000 });
    expect(groupStats([])).toMatchObject({ n: 0, insufficient: true, min: null });
  });
  test("8 values give p25 / median / p75", () => {
    const s = groupStats([10, 20, 30, 40, 50, 60, 70, 80].map((v) => v * 1000));
    expect(s.insufficient).toBe(false);
    expect([s.p25, s.median, s.p75]).toEqual([27500, 45000, 62500]);
  });
});

describe("aggregate", () => {
  const many = (n: number, over: Partial<RawJob>) => Array.from({ length: n }, (_, i) => job({ key: `k:${Math.random()}:${i}`, ...over, salary_min: 1000 + i * 100, salary_max: 1000 + i * 100 }));
  const meta = { generated_at: "2026-10-15T00:00:00.000Z", portals: ["x"] };

  test("counts discards and splits by skill and group", () => {
    const jobs = [
      ...many(8, { title: "Python Dev", location: "Remote (Mexico only)" }),
      ...many(9, { title: "Python Dev", location: "Remote (anywhere)" }),
      ...many(3, { title: "Python Dev", location: "Chile" }),
      job({ title: "Python Dev", salary_min: 51, salary_max: 51, salary_currency: "MXN" }),
      job({ title: "Python Dev", salary_min: null, salary_max: null }),
      job({ title: "Python Dev", location: "USA" }),
      job({ title: "Office manager" }),
    ];
    const agg = aggregate(jobs, DEFAULT_FX, meta);
    const py = agg.skills.find((s) => s.id === "python")!;
    expect(py.groups.mx.n).toBe(8);
    expect(py.groups.mx.insufficient).toBe(false);
    expect(py.groups.remote_intl.n).toBe(9);
    expect(py.groups.latam_local).toMatchObject({ n: 3, insufficient: true, median: null });
    expect(agg.discards).toMatchObject({ noise_low: 1, no_salary: 1, unclassified: 1, irrelevant: 1 });
    expect(agg.totals).toMatchObject({ unique_jobs: jobs.length, relevant_jobs: jobs.length - 1, used_with_salary: 20 });
    expect(agg.fx.USD).toBe(18.5);
  });

  test("combination = python AND one partner skill", () => {
    const jobs = [
      ...many(8, { title: "Python + OCR engineer", location: "Remote (anywhere)" }),
      ...many(4, { title: "Python Kubernetes platform", location: "Remote (anywhere)" }),
      ...many(5, { title: "Rust engineer", location: "Remote (anywhere)" }),
      ...many(5, { title: "Python Developer", location: "Remote (anywhere)" }),
      ...many(5, { title: "Kubernetes admin", location: "Remote (anywhere)" }),
    ];
    const agg = aggregate(jobs, DEFAULT_FX, meta);
    expect(agg.combo.groups.remote_intl.n).toBe(12);
    expect(agg.combo.relevant).toBe(12);
    expect(agg.skills.find((s) => s.id === "python")!.groups.remote_intl.n).toBe(17);
    expect(agg.skills.find((s) => s.id === "kubernetes")!.groups.remote_intl.n).toBe(9);
  });

  test("summary: lead sentence and ranking come only from reliable core samples", () => {
    const empty = buildSummary(aggregate([job()], DEFAULT_FX, meta));
    expect(empty.lead).toBeNull();
    expect(empty.ranked).toHaveLength(0);

    const jobs = [
      ...many(8, { title: "Python Dev", location: "Chile" }),
      ...many(8, { title: "Kubernetes Eng", location: "Chile", salary_currency: "EUR" }),
      ...many(8, { title: "Data Engineer", location: "Remote (anywhere)", salary_currency: "GBP" }),
      ...many(8, { title: "Accountant", location: "Remote (anywhere)", salary_currency: "CAD" }),
      ...many(3, { title: "Rust dev", location: "Chile" }),
    ];
    const sum = buildSummary(aggregate(jobs, DEFAULT_FX, meta));
    expect(sum.ranked.map((r) => r.id).sort()).toEqual(["data_engineer", "kubernetes", "python"]);
    // descending by median, accounting (a domain area) never ranks nor leads
    const meds = sum.ranked.map((r) => r.median);
    expect([...meds].sort((a, b) => b - a)).toEqual(meds);
    expect(sum.ranked.some((r) => r.id === "contable")).toBe(false);
    expect(sum.lead).toMatch(/^Con tus habilidades, en LatAm pagan alrededor de \$\d+k–\$\d+k al mes; en remoto abierto a México, hasta ~\$\d+k \(Data Engineer\)\.$/);
    expect(sum.lead).not.toMatch(/ccount|ontable/);
    expect(sum.fewData.map((f) => f.id)).toContain("rust");
    expect(sum.fewData.find((f) => f.id === "contable")?.domain).toBe(true);
    expect(sum.fewData.find((f) => f.id === "cfdi")).toBeTruthy();
  });

  test("summary names the combination plainly and lead omits a scope without data", () => {
    const jobs = [
      ...many(8, { title: "Python OCR Dev", location: "Chile" }),
    ];
    const sum = buildSummary(aggregate(jobs, DEFAULT_FX, meta));
    expect(sum.ranked.find((r) => r.id === "combo")?.label).toBe("Python + otra de tus especialidades");
    expect(sum.lead).toMatch(/en LatAm pagan alrededor de/);
    expect(sum.lead).not.toContain("remoto");
  });
});

describe("sampler with injected spawner", () => {
  const row = (id: string, extra: Record<string, unknown> = {}) => ({
    id, title: "Python Developer", company: "Acme", location: "Remote (anywhere)", url: `https://x/${id}`, remote: true, tags: [],
    salary: "USD 3000/month", salary_min: 3000, salary_max: 3000, salary_currency: "USD", salary_period: "month", ...extra,
  });

  function fakeCli(calls: string[][], respond: (argv: string[]) => { code: number; stdout: string }): CliSpawner {
    return async (argv) => {
      calls.push(argv);
      return respond(argv);
    };
  }
  const one = [{ ...SKILLS[2], queries: ["python"] }];
  const noSleep = async () => {};

  test("dedups, pages only when full, passes argv without a shell, writes raw + aggregate", async () => {
    const root = tempRoot();
    const calls: string[][] = [];
    const sleeps: number[] = [];
    const full = Array.from({ length: 100 }, (_, i) => row(`a${i}`));
    const spawn = fakeCli(calls, (argv) => {
      const portal = argv[2].includes("getonbrd") ? "getonbrd" : "other";
      const page = argv[argv.indexOf("--page") + 1];
      if (portal === "getonbrd" && !argv.includes("--latam")) return { code: 0, stdout: JSON.stringify({ results: page === "1" ? full : [row("a0"), row("p2")] }) };
      return { code: 0, stdout: JSON.stringify({ results: [row("a1"), row("b1")] }) };
    });
    const res = await sampleAll({
      root, spawn, bun: "bun", skills: one, sleep: async (ms) => void sleeps.push(ms),
      now: () => new Date("2026-10-15T10:00:00Z"),
    });
    const getonbrdAll = calls.filter((a) => a[2].includes("getonbrd") && !a.includes("--latam"));
    expect(getonbrdAll).toHaveLength(2); // page 1 was full -> page 2
    expect(calls.filter((a) => a[2].includes("jobicy"))).toHaveLength(2);
    expect(calls.filter((a) => a[2].includes("himalayas") && a.includes("Mexico"))).toHaveLength(1);
    expect(calls[0].slice(0, 2)).toEqual(["bun", "run"]);
    expect(calls[0]).toContain("--limit");
    expect(sleeps.every((ms) => ms >= 700)).toBe(true);
    expect(sleeps.length).toBe(res.calls.length);
    const raw = JSON.parse(readFileSync(res.rawPath, "utf8"));
    expect(res.rawPath).toBe(join(rawDir(root), "raw-2026-10-15.json"));
    expect(raw.jobs.filter((j: RawJob) => j.key === "getonbrd:a0")).toHaveLength(1);
    expect(raw.jobs.find((j: RawJob) => j.key === "getonbrd:a1").open_to_mx).toBe(true); // also seen via --latam
    const stored = loadAggregate(root)!;
    expect(stored.generated_at).toBe("2026-10-15T10:00:00.000Z");
    expect(stored.portals).toEqual(PORTALS.map((p) => p.portal));
    expect(stored.skills.find((s) => s.id === "python")!.groups.remote_intl.n).toBeGreaterThan(100);
  });

  test("a failing or malformed call is recorded and does not stop the run", async () => {
    const root = tempRoot();
    let n = 0;
    const res = await sampleAll({
      root, skills: one, sleep: noSleep, bun: "bun",
      spawn: fakeCli([], () => (++n === 1 ? { code: 1, stdout: "" } : n === 2 ? { code: 0, stdout: "not json" } : { code: 0, stdout: JSON.stringify({ results: [row("z")] }) })),
    });
    expect(res.calls.filter((c) => c.error).map((c) => c.error)).toEqual(["exit_1", "bad_output"]);
    expect(existsSync(aggregatePath(root))).toBe(true);
    expect(readdirSync(rawDir(root))).toHaveLength(1);
  });

  test("toRawJob needs an id or url", () => {
    expect(toRawJob("p", { title: "x" }, variant)).toBeNull();
    expect(toRawJob("p", { url: "https://a/b", title: "x" }, variant)?.key).toBe("p:https://a/b");
  });
});

describe("staleness", () => {
  test("missing or older than 15 days is stale", () => {
    const root = tempRoot();
    const now = new Date("2026-10-15T12:00:00Z");
    expect(isStale(root, now)).toBe(true);
    const write = (generated_at: string) => {
      const agg = aggregate([], DEFAULT_FX, { generated_at, portals: [] });
      mkdirSync(join(root, "ui", "state"), { recursive: true });
      writeFileSync(aggregatePath(root), JSON.stringify(agg));
    };
    write("2026-10-02T12:00:00Z");
    expect(isStale(root, now)).toBe(false);
    write("2026-09-30T11:00:00Z");
    expect(isStale(root, now)).toBe(true);
  });
});

describe("POST /api/market/refresh", () => {
  const noClaude: Spawner = () => { throw new Error("Claude must not be used"); };
  const post = (h: ReturnType<typeof createHandler>, headers: Record<string, string> = ORIGIN) =>
    h.handle(new Request(BASE + "/api/market/refresh", { method: "POST", headers, body: "{}" }));

  test("rejects a foreign Origin or Host", async () => {
    const h = createHandler({ root: tempRoot(), spawner: noClaude });
    expect((await post(h, { ...ORIGIN, Origin: "https://evil.com" })).status).toBe(403);
    expect((await post(h, { Host: "127.0.0.1:8787", "Content-Type": "application/json" })).status).toBe(403);
    expect((await post(h, { ...ORIGIN, Host: "evil.com" })).status).toBe(403);
  });

  test("answers busy while another run holds the lock, and runs the CLIs (not Claude) otherwise", async () => {
    const root = tempRoot();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[][] = [];
    const cliSpawner: CliSpawner = async (argv) => {
      calls.push(argv);
      await gate;
      return { code: 0, stdout: JSON.stringify({ results: [] }) };
    };
    const h = createHandler({ root, spawner: noClaude, cliSpawner, samplerPauseMs: 0 });
    const first = await post(h);
    expect(first.status).toBe(200);
    const { id } = await first.json();
    expect(typeof id).toBe("string");
    expect((await post(h)).status).toBe(409);
    // The lock is shared with Claude runs.
    expect((await h.handle(new Request(BASE + "/api/run/rank", { method: "POST", headers: ORIGIN, body: "{}" }))).status).toBe(409);
    expect(h.runs.current?.kind).toBe("market");
    release();
    for (let i = 0; i < 400 && h.runs.busy(); i++) await Bun.sleep(5);
    expect(h.runs.current?.status).toBe("done");
    expect(calls.length).toBeGreaterThan(50);
    const data = await (await h.handle(new Request(BASE + "/api/skills", { headers: { Host: "127.0.0.1:8787" } }))).json();
    expect(data.aggregate.version).toBe(1);
    expect(typeof data.summary.ranked.length).toBe("number");
    expect(data.reference.bands).toHaveLength(6);
  });

  test("GET /api/skills without data returns an empty state", async () => {
    const h = createHandler({ root: tempRoot(), spawner: noClaude });
    const data = await (await h.handle(new Request(BASE + "/api/skills", { headers: { Host: "127.0.0.1:8787" } }))).json();
    expect(data.aggregate).toBeNull();
    expect(data.summary).toBeNull();
  });
});
