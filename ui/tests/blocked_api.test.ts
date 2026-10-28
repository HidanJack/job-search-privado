import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../server";

const BASE = "http://127.0.0.1:8787";
const ORIGIN = { Origin: BASE, Host: "127.0.0.1:8787", "Content-Type": "application/json" };

function rootWith(): string {
  const root = mkdtempSync(join(tmpdir(), "job-ui-blk-"));
  mkdirSync(join(root, "job_scraper"));
  const day = new Date().toLocaleDateString("en-CA");
  const seen: Record<string, unknown> = {
    r1: { title: "Dev One", company: "Acme Spam Corp", status: "ranked", posted_date: day, rank_score: 70, modality: "remote", posting_language: "es", salary_mxn_month: 50000 },
    r2: { title: "Dev Two", company: "Fine Co", status: "ranked", posted_date: day, rank_score: 70, modality: "remote", posting_language: "es", salary_mxn_month: 50000 },
    n1: { title: "Dev Three", company: "Acme Spam, S.A. de C.V.", status: "new", posted_date: day },
  };
  for (let i = 0; i < 9; i++) seen[`old${i}`] = { title: `Old ${i}`, company: "Stale Postings Inc", status: "skipped", posted_date: "2026-01-01" };
  writeFileSync(join(root, "job_scraper", "seen_jobs.json"), JSON.stringify({ seen }));
  mkdirSync(join(root, "tools"));
  writeFileSync(join(root, "tools", "prefilter.py"), "# stub: the spawner is faked in tests\n");
  writeFileSync(join(root, "profile_config.json"), JSON.stringify({ name: "X", candidate_years: 3 }));
  return root;
}
const call = (h: ReturnType<typeof createHandler>, method: string, body?: unknown, headers: Record<string, string> = ORIGIN) =>
  h.handle(new Request(BASE + "/api/blocked-companies", { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));

async function withoutEnv<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.JOB_SEARCH_PROFILE_CONFIG;
  delete process.env.JOB_SEARCH_PROFILE_CONFIG;
  try { return await fn(); } finally { if (prev !== undefined) process.env.JOB_SEARCH_PROFILE_CONFIG = prev; }
}

describe("/api/blocked-companies", () => {
  test("GET lists entries, match counts and suggestions (never auto-blocking)", () => withoutEnv(async () => {
    const h = createHandler({ root: rootWith() });
    const body = await (await call(h, "GET", undefined, { Host: "127.0.0.1:8787" })).json();
    expect(body.entries).toEqual([]);
    expect(body.suggestions.map((s: { company: string }) => s.company)).toEqual(["Stale Postings Inc"]);
  }));

  test("POST blocks, runs the prefilter, hides the jobs and backs up the config", () => withoutEnv(async () => {
    const root = rootWith();
    const argvs: string[][] = [];
    const h = createHandler({ root, sweepSpawn: async (argv) => { argvs.push(argv); return { code: 0, stdout: "{}" }; } });
    const res = await call(h, "POST", { name: "Acme Spam", reason: "vacantes basura" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.added).toBe(true);
    expect(body.prefilter).toBe("ok");
    expect(argvs[0]).toEqual(["python3", "tools/prefilter.py", "run", "--write"]);
    expect(body.matches["Acme Spam"]).toBe(2);
    const cfg = JSON.parse(readFileSync(join(root, "profile_config.json"), "utf8"));
    expect(cfg.candidate_years).toBe(3);
    expect(cfg.blocked_companies[0]).toMatchObject({ name: "Acme Spam", reason: "vacantes basura" });
    expect(readdirSync(join(root, "ui", "state", "backups")).length).toBe(1);
    const jobs = await (await h.handle(new Request(BASE + "/api/jobs?maxDays=30&minSalary=0", { headers: { Host: "127.0.0.1:8787" } }))).json();
    expect(jobs.ranked.map((j: { key: string }) => j.key)).toEqual(["r2"]);
    expect(jobs.unranked).toEqual([]);
    expect(jobs.counts.blockedHidden).toBe(2);
    // the state file is untouched by the API itself: nothing is deleted
    expect(Object.keys(JSON.parse(readFileSync(join(root, "job_scraper", "seen_jobs.json"), "utf8")).seen).length).toBe(12);
  }));

  test("a second POST of the same company is a no-op", () => withoutEnv(async () => {
    const h = createHandler({ root: rootWith(), sweepSpawn: async () => ({ code: 0, stdout: "{}" }) });
    await call(h, "POST", { name: "Acme Spam" });
    const again = await (await call(h, "POST", { name: "ACME SPAM inc." })).json();
    expect(again.added).toBe(false);
    expect(again.entries.length).toBe(1);
  }));

  test("DELETE removes; unknown names are 404", () => withoutEnv(async () => {
    const h = createHandler({ root: rootWith(), sweepSpawn: async () => ({ code: 0, stdout: "{}" }) });
    await call(h, "POST", { name: "Acme Spam" });
    expect((await call(h, "DELETE", { name: "nope" })).status).toBe(404);
    const res = await call(h, "DELETE", { name: "Acme Spam" });
    expect(res.status).toBe(200);
    expect((await res.json()).entries).toEqual([]);
  }));

  test("validation and guards", () => withoutEnv(async () => {
    const h = createHandler({ root: rootWith(), sweepSpawn: async () => ({ code: 0, stdout: "{}" }) });
    expect((await call(h, "POST", { name: "" })).status).toBe(400);
    expect((await call(h, "POST", { name: "A", aliases: "B" })).status).toBe(400);
    expect((await call(h, "POST", { name: "Acme" }, { Host: "127.0.0.1:8787", "Content-Type": "application/json", Origin: "http://evil.example" })).status).toBe(403);
    expect((await call(h, "DELETE", { name: "Acme" }, { Host: "127.0.0.1:8787", "Content-Type": "application/json", Origin: "http://evil.example" })).status).toBe(403);
    expect((await call(h, "POST", { name: "Acme" }, { Origin: BASE, Host: "evil.example", "Content-Type": "application/json" })).status).toBe(403);
    expect((await call(h, "PUT", { name: "Acme" })).status).toBe(405);
    expect((await call(h, "POST", { name: "Acme" }, { Origin: BASE, Host: "127.0.0.1:8787" })).status).toBe(400); // not JSON
  }));

  test("the card helpers are served as a module script", () => withoutEnv(async () => {
    const res = await createHandler({ root: rootWith() }).handle(new Request(BASE + "/job-logic.js", { headers: { Host: "127.0.0.1:8787" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toContain("languageChips");
  }));
});
