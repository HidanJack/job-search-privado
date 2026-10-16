import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../server";
import {
  computeReadings, loadMarket, loadSettings, marketJobs, parseSettings, saveSettings, settingsPath, validateMarket,
  type MarketData, type MarketJob,
} from "../lib/market";
import { normalizeJob } from "../lib/jobs";

const BASE = "http://127.0.0.1:8787";
const ORIGIN = { Origin: BASE, Host: "127.0.0.1:8787", "Content-Type": "application/json" };
const tempRoot = () => mkdtempSync(join(tmpdir(), "job-ui-market-"));
const post = (h: ReturnType<typeof createHandler>, body: unknown, headers: Record<string, string> = ORIGIN) =>
  h.handle(new Request(BASE + "/api/settings", { method: "POST", headers, body: JSON.stringify(body) }));
const get = (h: ReturnType<typeof createHandler>, path: string) =>
  h.handle(new Request(BASE + path, { headers: { Host: "127.0.0.1:8787" } }));

describe("market reference data", () => {
  const market = loadMarket();
  test("ships the researched figures and passes validation", () => {
    expect(market.entries).toHaveLength(9);
    const py = market.entries.find((e) => e.id === "python-mx")!;
    expect([py.avg, py.min, py.max]).toEqual([20173, 13800, 29400]);
    expect(market.entries.filter((e) => e.evidence === "dubious").map((e) => e.source).sort())
      .toEqual(["Axented", "Talently", "Talently"]);
  });
  test("contains no personal data", () => {
    const text = readFileSync(join(import.meta.dir, "..", "data", "market_salaries.json"), "utf8");
    expect(text).not.toMatch(/currentSalary|targetSalary|luis/i);
  });
  test("rejects malformed entries", () => {
    const bad = (patch: Record<string, unknown>) => {
      const copy = structuredClone(market) as MarketData;
      Object.assign(copy.entries[0], patch);
      expect(() => validateMarket(copy)).toThrow();
    };
    bad({ evidence: "maybe" });
    bad({ min: 40000 }); // min > max
    bad({ avg: 99999 }); // outside range
    bad({ max: null }); // lone bound
    bad({ url: "http://insecure.example" });
    bad({ date: "yesterday" });
    bad({ avg: -5 });
    expect(() => validateMarket({ ...market, entries: [market.entries[0], market.entries[0]] })).toThrow();
    expect(() => validateMarket(null)).toThrow();
    expect(() => validateMarket({ ...market, entries: [] })).toThrow();
  });
});

describe("readings", () => {
  const market = loadMarket();
  const jobs: MarketJob[] = [
    { key: "a", title: "A", company: "X", salary: 40000, modality: "unknown", language: null },
    { key: "b", title: "B", company: "Y", salary: 90000, modality: "remote", language: "en" },
    { key: "c", title: "C", company: "Z", salary: 150000, modality: "remote", language: null },
  ];
  test("empty settings: only the market-vs-jobs sentence", () => {
    const r = computeReadings(market, jobs, { currentSalary: null, targetSalary: null });
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("3 de tus 3");
  });
  test("salary at the average", () => {
    const r = computeReadings(market, jobs, { currentSalary: 21000, targetSalary: null });
    expect(r[0]).toBe("Tu sueldo actual ($21,000) está en el promedio de Indeed MX para Python en México ($20,173).");
  });
  test("target above the range top, with jobs meeting it", () => {
    const r = computeReadings(market, jobs, { currentSalary: 15000, targetSalary: 50000 });
    expect(r).toHaveLength(3);
    expect(r[0]).toContain("26% por debajo");
    expect(r[1]).toContain("148% por encima");
    expect(r[1]).toContain("supera el tope del rango típico ($29,400)");
    expect(r[2]).toBe("2 de tus 3 vacantes calificadas con sueldo publicado pagan $50,000 o más (todas remotas).");
  });
  test("below the range floor", () => {
    const r = computeReadings(market, [], { currentSalary: 10000, targetSalary: null });
    expect(r[0]).toContain("bajo el piso del rango típico ($13,800)");
    expect(r[1]).toContain("Todavía no hay vacantes");
  });
  test("zero counts as empty", () => {
    expect(computeReadings(market, [], { currentSalary: 0, targetSalary: 0 })).toHaveLength(1);
  });
  test("marketJobs keeps only ranked jobs with a salary, sorted", () => {
    const mk = (key: string, status: string, salary: number | null) =>
      normalizeJob(key, { title: key, company: "C", status, salary_mxn_month: salary, modality: "remote" }, new Date());
    const out = marketJobs([mk("x", "ranked", 50000), mk("y", "new", 60000), mk("z", "ranked", null), mk("w", "ranked", 30000)]);
    expect(out.map((j) => j.key)).toEqual(["w", "x"]);
  });
});

describe("settings", () => {
  test("parseSettings is strict", () => {
    expect(parseSettings({ currentSalary: 20000, targetSalary: null })).toEqual({ currentSalary: 20000, targetSalary: null });
    expect(parseSettings({ currentSalary: 0, targetSalary: 1_000_000 })).not.toBeNull();
    for (const bad of [
      { currentSalary: -1, targetSalary: null },
      { currentSalary: 1_000_001, targetSalary: null },
      { currentSalary: 20000.5, targetSalary: null },
      { currentSalary: "20000", targetSalary: null },
      { currentSalary: NaN, targetSalary: null },
      { currentSalary: 1 },
      { currentSalary: 1, targetSalary: 2, extra: 3 },
      [],
      null,
    ]) expect(parseSettings(bad)).toBeNull();
  });

  test("GET is empty by default, POST persists to ui/state/settings.json", async () => {
    const root = tempRoot();
    const h = createHandler({ root });
    expect(await (await get(h, "/api/settings")).json()).toEqual({ currentSalary: null, targetSalary: null });
    const res = await post(h, { currentSalary: 25000, targetSalary: 45000 });
    expect(res.status).toBe(200);
    expect(existsSync(settingsPath(root))).toBe(true);
    expect(JSON.parse(readFileSync(settingsPath(root), "utf8"))).toEqual({ currentSalary: 25000, targetSalary: 45000 });
    expect(await (await get(createHandler({ root }), "/api/settings")).json()).toEqual({ currentSalary: 25000, targetSalary: 45000 });
  });

  test("foreign Origin or missing Origin is rejected and nothing is written", async () => {
    const root = tempRoot();
    const h = createHandler({ root });
    const body = { currentSalary: 1, targetSalary: 2 };
    expect((await post(h, body, { ...ORIGIN, Origin: "https://evil.com" })).status).toBe(403);
    const { Origin: _o, ...noOrigin } = ORIGIN;
    expect((await post(h, body, noOrigin)).status).toBe(403);
    expect((await post(h, body, { ...ORIGIN, Host: "evil.com" })).status).toBe(403);
    expect(existsSync(settingsPath(root))).toBe(false);
  });

  test("invalid values are rejected with 400 and nothing is written", async () => {
    const root = tempRoot();
    const h = createHandler({ root });
    for (const bad of [
      { currentSalary: -5, targetSalary: null },
      { currentSalary: 2_000_000, targetSalary: null },
      { currentSalary: 1.5, targetSalary: null },
      { currentSalary: "abc", targetSalary: null },
      { currentSalary: 1000 },
    ]) expect((await post(h, bad)).status).toBe(400);
    expect(existsSync(settingsPath(root))).toBe(false);
  });

  test("a corrupt settings file falls back to empty", () => {
    const root = tempRoot();
    saveSettings(root, { currentSalary: 1, targetSalary: 2 });
    writeFileSync(settingsPath(root), "{not json");
    expect(loadSettings(root)).toEqual({ currentSalary: null, targetSalary: null });
  });

  test("/api/market returns reference, jobs, settings and readings", async () => {
    const root = tempRoot();
    saveSettings(root, { currentSalary: 20000, targetSalary: null });
    const data = await (await get(createHandler({ root }), "/api/market")).json();
    expect(data.market.entries.length).toBe(9);
    expect(Array.isArray(data.jobs)).toBe(true);
    expect(data.readings[0]).toContain("Tu sueldo actual");
  });
});
