import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../server";
import { saveSettings, settingsPath, loadSettings } from "../lib/market";
import {
  DEFAULT_SEARCH, loadSearchSettings, parseSearchPatch, saveSearchSettings,
} from "../lib/search_settings";

const BASE = "http://127.0.0.1:8787";
const ORIGIN = { Origin: BASE, Host: "127.0.0.1:8787", "Content-Type": "application/json" };
const FIXTURES = join(import.meta.dir, "fixtures");

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "job-ui-ss-"));
  mkdirSync(join(root, "job_scraper"));
  cpSync(join(FIXTURES, "seen_jobs.json"), join(root, "job_scraper", "seen_jobs.json"));
  writeFileSync(join(root, "CLAUDE.md"), "# Alex\n- **Freshness window:** 4 days\n");
  return root;
}
const get = (h: ReturnType<typeof createHandler>, path: string) =>
  h.handle(new Request(BASE + path, { headers: { Host: "127.0.0.1:8787" } }));
const post = (h: ReturnType<typeof createHandler>, path: string, body: unknown, headers: Record<string, string> = ORIGIN) =>
  h.handle(new Request(BASE + path, { method: "POST", headers, body: JSON.stringify(body) }));

describe("parseSearchPatch", () => {
  test("accepts valid partial objects", () => {
    expect(parseSearchPatch({ maxDays: 14 })).toEqual({ maxDays: 14 });
    expect(parseSearchPatch({ minSalaryMxn: 0, hideEnglish: false, modalities: ["remote", "hybrid"] })).toEqual({
      minSalaryMxn: 0, hideEnglish: false, modalities: ["remote", "hybrid"],
    });
  });

  test("rejects out-of-range, wrong types and unknown keys", () => {
    for (const bad of [
      null, [], "x", {}, { maxDays: 0 }, { maxDays: 91 }, { maxDays: 1.5 }, { maxDays: "7" },
      { minSalaryMxn: -1 }, { minSalaryMxn: 1_000_001 }, { minSalaryMxn: NaN },
      { hideEnglish: "yes" }, { includeUndated: 1 }, { includeUnpublishedSalary: null },
      { modalities: "remote" }, { modalities: ["remote", "moon"] }, { modalities: ["remote", "remote"] },
      { maxDays: 7, extra: true },
    ]) expect(parseSearchPatch(bad)).toBeNull();
  });
});

describe("persistence", () => {
  test("defaults when the file is missing or has no search block", () => {
    const root = tempRoot();
    expect(loadSearchSettings(root)).toEqual(DEFAULT_SEARCH);
    expect(DEFAULT_SEARCH.maxDays).toBe(7);
    expect(DEFAULT_SEARCH.minSalaryMxn).toBe(30000);
    saveSettings(root, { currentSalary: 20000, targetSalary: null });
    expect(loadSearchSettings(root)).toEqual(DEFAULT_SEARCH);
  });

  test("the default salary floor follows profile_config.json", () => {
    const root = tempRoot();
    writeFileSync(join(root, "profile_config.json"), JSON.stringify({ name: "Alex Example", salary_floor_mxn: 51000 }));
    expect(loadSearchSettings(root).minSalaryMxn).toBe(51000);
    saveSearchSettings(root, { ...loadSearchSettings(root), minSalaryMxn: 47000 });
    expect(loadSearchSettings(root).minSalaryMxn).toBe(47000); // an explicit saved value still wins
  });

  test("saving search keeps the salary keys, and saving salaries keeps search", () => {
    const root = tempRoot();
    saveSettings(root, { currentSalary: 20000, targetSalary: 50000 });
    saveSearchSettings(root, { ...DEFAULT_SEARCH, maxDays: 10 });
    const file = JSON.parse(readFileSync(settingsPath(root), "utf8"));
    expect(file.currentSalary).toBe(20000);
    expect(file.targetSalary).toBe(50000);
    expect(file.search.maxDays).toBe(10);
    expect(loadSettings(root)).toEqual({ currentSalary: 20000, targetSalary: 50000 });
    saveSettings(root, { currentSalary: 22000, targetSalary: 50000 });
    expect(loadSearchSettings(root).maxDays).toBe(10);
  });

  test("invalid stored fields fall back to defaults one by one", () => {
    const root = tempRoot();
    mkdirSync(join(root, "ui", "state"), { recursive: true });
    writeFileSync(settingsPath(root), JSON.stringify({ currentSalary: 1, targetSalary: null, search: { maxDays: 999, hideEnglish: false } }));
    const s = loadSearchSettings(root);
    expect(s.maxDays).toBe(DEFAULT_SEARCH.maxDays);
    expect(s.hideEnglish).toBe(false);
  });
});

describe("/api/search-settings", () => {
  test("GET returns defaults plus the last sweep (null at first)", async () => {
    const h = createHandler({ root: tempRoot() });
    const body = await (await get(h, "/api/search-settings")).json();
    expect(body.search).toEqual(DEFAULT_SEARCH);
    expect(body.lastSweep).toBeNull();
  });

  test("POST merges, persists and survives a new handler", async () => {
    const root = tempRoot();
    const h = createHandler({ root });
    const res = await post(h, "/api/search-settings", { maxDays: 14, modalities: ["remote"] });
    expect(res.status).toBe(200);
    const saved = await res.json();
    expect(saved.maxDays).toBe(14);
    expect(saved.minSalaryMxn).toBe(30000);
    expect(existsSync(settingsPath(root))).toBe(true);
    const again = await (await get(createHandler({ root }), "/api/search-settings")).json();
    expect(again.search.maxDays).toBe(14);
    expect(again.search.modalities).toEqual(["remote"]);
  });

  test("POST validates, enforces origin and JSON content type", async () => {
    const root = tempRoot();
    const h = createHandler({ root });
    expect((await post(h, "/api/search-settings", { maxDays: 500 })).status).toBe(400);
    expect((await post(h, "/api/search-settings", { nope: 1 })).status).toBe(400);
    expect((await post(h, "/api/search-settings", { maxDays: 5 }, { ...ORIGIN, Origin: "https://evil.com" })).status).toBe(403);
    const form = await h.handle(new Request(BASE + "/api/search-settings", { method: "POST", headers: { ...ORIGIN, "Content-Type": "text/plain" }, body: "{}" }));
    expect(form.status).toBe(400);
    const huge = await post(h, "/api/search-settings", { maxDays: 5, pad: "x".repeat(20_000) });
    expect(huge.status).toBe(400);
    expect(existsSync(settingsPath(root))).toBe(false);
  });

  test("/api/settings POST (salaries) does not drop the search block", async () => {
    const root = tempRoot();
    const h = createHandler({ root });
    await post(h, "/api/search-settings", { maxDays: 21 });
    expect((await post(h, "/api/settings", { currentSalary: 30000, targetSalary: null })).status).toBe(200);
    expect((await (await get(h, "/api/search-settings")).json()).search.maxDays).toBe(21);
    expect(await (await get(h, "/api/settings")).json()).toEqual({ currentSalary: 30000, targetSalary: null });
  });

  test("/api/jobs uses the saved settings when the query has no filters", async () => {
    const root = tempRoot();
    const h = createHandler({ root });
    await post(h, "/api/search-settings", { maxDays: 33, minSalaryMxn: 12345, hideEnglish: false, includeUndated: false, includeUnpublishedSalary: false, modalities: ["remote"] });
    const data = await (await get(h, "/api/jobs")).json();
    expect(data.filters).toEqual({
      maxDays: 33, minSalaryMxn: 12345, includeNoSalary: false, includeUndated: false, hideEnglish: false, modalities: ["remote"],
    });
    const explicit = await (await get(h, "/api/jobs?maxDays=2")).json();
    expect(explicit.filters.maxDays).toBe(2);
    expect(explicit.filters.minSalaryMxn).toBe(12345);
  });
});
