import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../server";
import { filterJobs, forceRankJob, normalizeJob, passesGate, prefilteredJobs, recoverJob, skipJob, splitByGate, type Filters } from "../lib/jobs";
import { runTool, toolArgv } from "../lib/prefilter";
import { DEFAULT_SEARCH, parseSearchPatch, loadSearchSettings } from "../lib/search_settings";

const BASE = "http://127.0.0.1:8787";
const ORIGIN = { Origin: BASE, Host: "127.0.0.1:8787", "Content-Type": "application/json" };
const TODAY = new Date(2026, 9, 16);
const FILTERS: Filters = { maxDays: 365, minSalaryMxn: 0, includeNoSalary: true, includeUndated: true, hideEnglish: false, modalities: ["remote", "hybrid", "onsite", "unknown"] };

function root(search?: Record<string, unknown>, seen: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "job-ui-pf-"));
  mkdirSync(join(dir, "job_scraper"));
  mkdirSync(join(dir, "ui", "state"), { recursive: true });
  cpSync(join(import.meta.dir, "fixtures", "seen_jobs.json"), join(dir, "job_scraper", "seen_jobs.json"));
  const doc = JSON.parse(readFileSync(join(dir, "job_scraper", "seen_jobs.json"), "utf8"));
  Object.assign(doc.seen, seen);
  writeFileSync(join(dir, "job_scraper", "seen_jobs.json"), JSON.stringify(doc));
  writeFileSync(join(dir, "CLAUDE.md"), "# Alex\n- **Freshness window:** 4 days\n- **Salary floor:** 45000 MXN/month\n");
  if (search) writeFileSync(join(dir, "ui", "state", "settings.json"), JSON.stringify({ search }));
  return dir;
}
const get = (h: ReturnType<typeof createHandler>, path: string) => h.handle(new Request(BASE + path, { headers: { Host: "127.0.0.1:8787" } }));
const post = (h: ReturnType<typeof createHandler>, path: string, body: unknown) =>
  h.handle(new Request(BASE + path, { method: "POST", headers: ORIGIN, body: JSON.stringify(body) }));
const raw = (over: Record<string, unknown>) => ({ title: "T", company: "C", status: "new", posted_date: "2026-10-15", ...over });

describe("rankBatch setting", () => {
  test("defaults to 10 and validates 1..200 integers", () => {
    expect(DEFAULT_SEARCH.rankBatch).toBe(10);
    expect(parseSearchPatch({ rankBatch: 40 })).toEqual({ rankBatch: 40 });
    for (const bad of [0, 201, 1.5, "25", null, -3]) expect(parseSearchPatch({ rankBatch: bad })).toBeNull();
  });

  test("API saves it and falls back to 10 when the stored value is invalid", async () => {
    const r = root({ rankBatch: 9999 });
    expect(loadSearchSettings(r).rankBatch).toBe(10);
    const h = createHandler({ root: r });
    expect((await post(h, "/api/search-settings", { rankBatch: 60 })).status).toBe(200);
    expect((await post(h, "/api/search-settings", { rankBatch: 0 })).status).toBe(400);
    expect((await (await get(h, "/api/search-settings")).json()).search.rankBatch).toBe(60);
  });
});

describe("minPrefilterScore gate", () => {
  test("defaults to 55, accepts 0..100 integers only", () => {
    expect(DEFAULT_SEARCH.minPrefilterScore).toBe(55);
    expect(parseSearchPatch({ minPrefilterScore: 0 })).toEqual({ minPrefilterScore: 0 });
    expect(parseSearchPatch({ minPrefilterScore: 100 })).toEqual({ minPrefilterScore: 100 });
    for (const bad of [-1, 101, 1.5, "52", null]) expect(parseSearchPatch({ minPrefilterScore: bad })).toBeNull();
  });

  test("passesGate and splitByGate mirror rank_state candidates", () => {
    const mk = (key: string, extra: Record<string, unknown>) => normalizeJob(key, raw(extra), TODAY);
    const jobs = [mk("hi", { prefilter_score: 60 }), mk("edge", { prefilter_score: 52 }), mk("lo", { prefilter_score: 40 }), mk("forced", { prefilter_score: 10, force_rank: true })];
    expect(passesGate(jobs[2], 52)).toBe(false);
    const { eligible, gated } = splitByGate(jobs, 52);
    expect(eligible.map((j) => j.key)).toEqual(["hi", "edge", "forced"]);
    expect(gated.map((j) => j.key)).toEqual(["lo"]);
  });

  test("forceRankJob flags only pending jobs and keeps them new", () => {
    const r = root(undefined, { low: raw({ prefilter_score: 5 }), done: raw({ status: "ranked" }) });
    expect(forceRankJob(r, "done")).toBe(false);
    expect(forceRankJob(r, "nope")).toBe(false);
    expect(forceRankJob(r, "low")).toBe(true);
    const e = JSON.parse(readFileSync(join(r, "job_scraper", "seen_jobs.json"), "utf8")).seen;
    expect(e.low.status).toBe("new");
    expect(e.low.force_rank).toBe(true);
    expect(e.done.force_rank).toBeUndefined();
  });

  test("/api/jobs lists gated jobs apart and /api/jobs/force-rank moves one into the queue", async () => {
    const r = root({ minPrefilterScore: 50 }, { lowA: raw({ prefilter_score: 20 }), highA: raw({ prefilter_score: 80 }) });
    const h = createHandler({ root: r });
    const q = "/api/jobs?maxDays=365&minSalary=0";
    const data = await (await get(h, q)).json();
    expect(data.minPrefilterScore).toBe(50);
    expect(data.gated.map((j: { key: string }) => j.key)).toContain("lowA");
    expect(data.unranked.map((j: { key: string }) => j.key)).toContain("highA");
    expect(data.unranked.map((j: { key: string }) => j.key)).not.toContain("lowA");
    expect(data.counts.pending).toBe(data.counts.eligible + data.counts.gated);
    expect((await post(h, "/api/jobs/force-rank", { key: "lowA" })).status).toBe(200);
    expect((await post(h, "/api/jobs/force-rank", { key: "ghost" })).status).toBe(404);
    expect((await post(h, "/api/jobs/force-rank", { key: 7 })).status).toBe(400);
    const after = await (await get(h, q)).json();
    expect(after.gated.map((j: { key: string }) => j.key)).not.toContain("lowA");
    expect(after.unranked.map((j: { key: string }) => j.key)).toContain("lowA");
    expect(after.counts.gated).toBe(data.counts.gated - 1);
  });

  test("force-rank rejects cross-origin requests like the other write endpoints", async () => {
    const h = createHandler({ root: root(undefined, { x: raw({ prefilter_score: 1 }) }) });
    const res = await h.handle(new Request(BASE + "/api/jobs/force-rank", {
      method: "POST", headers: { Origin: "http://evil.example", Host: "127.0.0.1:8787", "Content-Type": "application/json" }, body: JSON.stringify({ key: "x" }),
    }));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("prefiltered jobs", () => {
  test("unranked are ordered by prefilter score; prefiltered_out are listed apart", () => {
    const jobs = [
      normalizeJob("a", raw({ prefilter_score: 40 }), TODAY),
      normalizeJob("b", raw({ prefilter_score: 90 }), TODAY),
      normalizeJob("c", raw({ status: "prefiltered_out", prefilter_score: 10, prefilter_reason: "Puesto de ventas" }), TODAY),
    ];
    expect(filterJobs(jobs, FILTERS).unranked.map((j) => j.key)).toEqual(["b", "a"]);
    const out = prefilteredJobs(jobs);
    expect(out.map((j) => j.key)).toEqual(["c"]);
    expect(out[0].prefilter_reason).toBe("Puesto de ventas");
  });

  test("prefilter_why keeps only short strings, defaults to an empty list", () => {
    const a = normalizeJob("a", raw({ prefilter_why: ["Sube: python, fastapi", 7, "Baja: net", "x", "y"] }), TODAY);
    expect(a.prefilter_why).toEqual(["Sube: python, fastapi", "Baja: net", "x"]);
    expect(normalizeJob("b", raw({}), TODAY).prefilter_why).toEqual([]);
  });

  test("ranked cards sort by final_priority, falling back to priority_score", () => {
    const base = { status: "ranked", rank_score: 70 };
    const jobs = [
      normalizeJob("low", raw({ ...base, priority_score: 90, final_priority: 40 }), TODAY),
      normalizeJob("high", raw({ ...base, priority_score: 50, final_priority: 80 }), TODAY),
      normalizeJob("legacy", raw({ ...base, priority_score: 60 }), TODAY),
    ];
    expect(filterJobs(jobs, FILTERS).ranked.map((j) => j.key)).toEqual(["high", "legacy", "low"]);
  });

  test("opportunity fields are read when valid and null otherwise", () => {
    const j = normalizeJob("a", raw({ opportunity: 78, risk: 30, final_priority: 66, opportunity_driver: "Remoto", risk_driver: 5 }), TODAY);
    expect([j.opportunity, j.risk, j.final_priority, j.opportunity_driver, j.risk_driver]).toEqual([78, 30, 66, "Remoto", null]);
  });

  test("recoverJob moves it back to new, only for prefiltered_out, and never deletes", () => {
    const r = root(undefined, { gone: raw({ status: "prefiltered_out", prefilter_reason: "x" }), live: raw({ status: "ranked" }) });
    expect(recoverJob(r, "live")).toBe(false);
    expect(recoverJob(r, "nope")).toBe(false);
    expect(recoverJob(r, "gone")).toBe(true);
    const e = JSON.parse(readFileSync(join(r, "job_scraper", "seen_jobs.json"), "utf8")).seen.gone;
    expect(e.status).toBe("new");
    expect(e.prefilter_recovered).toBe(true);
    expect(e.prefilter_reason).toBeUndefined();
    expect(skipJob(r, "gone")).toBe(true);
  });
});

describe("API", () => {
  test("lists prefiltered jobs, counts and rankBatch; recover endpoint works", async () => {
    const r = root({ rankBatch: 30 }, { auto: raw({ status: "prefiltered_out", prefilter_reason: "Puesto de ventas", prefilter_score: 5 }) });
    const h = createHandler({ root: r });
    const data = await (await get(h, "/api/jobs?maxDays=365&minSalary=0")).json();
    expect(data.rankBatch).toBe(30);
    expect(data.counts.prefilteredOut).toBe(1);
    expect(data.prefiltered[0].prefilter_reason).toBe("Puesto de ventas");
    const pendingBefore = data.counts.pending;
    expect((await post(h, "/api/jobs/recover", { key: "auto" })).status).toBe(200);
    expect((await post(h, "/api/jobs/recover", { key: "auto" })).status).toBe(404);
    expect((await post(h, "/api/jobs/recover", { key: 5 })).status).toBe(400);
    const after = await (await get(h, "/api/jobs?maxDays=365&minSalary=0")).json();
    expect(after.counts.pending).toBe(pendingBefore + 1);
    expect(after.counts.prefilteredOut).toBe(0);
  });

  test("search settings override CLAUDE.md for the window and salary floor in the profile", async () => {
    const h = createHandler({ root: root({ maxDays: 7, minSalaryMxn: 36000 }) });
    const data = await (await get(h, "/api/jobs")).json();
    expect(data.profile.freshnessDays).toBe(7);
    expect(data.profile.salaryFloorMxn).toBe(36000);
  });

  test("defaults (no saved settings) still beat CLAUDE.md's 4 days / the default floor", async () => {
    const data = await (await get(createHandler({ root: root() }), "/api/jobs")).json();
    expect(data.profile.freshnessDays).toBe(DEFAULT_SEARCH.maxDays);
    expect(data.profile.salaryFloorMxn).toBe(DEFAULT_SEARCH.minSalaryMxn);
  });
});

describe("python tool steps", () => {
  test("argv is fixed and a missing script is skipped, not failed", async () => {
    expect(toolArgv("prefilter")).toEqual(["python3", "tools/prefilter.py", "run", "--write"]);
    expect(toolArgv("opportunity")).toEqual(["python3", "tools/opportunity.py", "recompute", "--write"]);
    expect(toolArgv("learned")).toEqual(["python3", "tools/learned_score.py", "train"]);
    const logs: string[] = [];
    expect(await runTool(root(), "prefilter", (l) => logs.push(l), async () => { throw new Error("must not spawn"); })).toBe(true);
    expect(logs[0]).toContain("Omitido");
  });

  test("learned training logs CV metrics compactly in Spanish", async () => {
    const r = root();
    mkdirSync(join(r, "tools"));
    writeFileSync(join(r, "tools", "learned_score.py"), "");
    const logs: string[] = [];
    const summary = { labels: 217, good: 46, active: true, cv: { hand_full: { spearman: 0.36, auc: 0.63, p10: 0.44, p25: 0.41 }, blend: { spearman: 0.4, auc: 0.62, p10: 0.57, p25: 0.41 } } };
    expect(await runTool(r, "learned", (l) => logs.push(l), async () => ({ code: 0, stdout: JSON.stringify(summary) + "\n" }))).toBe(true);
    expect(logs.at(-1)).toContain("Modelo aprendido: 217 etiquetas");
    expect(logs.at(-1)).toContain("blend spearman=0.4 auc=0.62 p10=0.57 p25=0.41");
    expect(logs.at(-1)).toContain("heurística spearman=0.36");
  });

  test("runs the script and reports its summary or its failure", async () => {
    const r = root();
    mkdirSync(join(r, "tools"));
    writeFileSync(join(r, "tools", "prefilter.py"), "");
    const logs: string[] = [];
    expect(await runTool(r, "prefilter", (l) => logs.push(l), async () => ({ code: 0, stdout: '{"kept": 3}\n' }))).toBe(true);
    expect(logs.at(-1)).toContain('{"kept": 3}');
    expect(await runTool(r, "prefilter", (l) => logs.push(l), async () => ({ code: 2, stdout: "" }))).toBe(false);
  });
});
