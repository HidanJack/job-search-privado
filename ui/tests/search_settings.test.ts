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
    expect(parseSearchPatch({ minSalaryMxn: 0, hideUnspoken: false, modalities: ["remote", "hybrid"] })).toEqual({
      minSalaryMxn: 0, hideUnspoken: false, modalities: ["remote", "hybrid"],
    });
  });

  test("the old hideEnglish key is accepted as an alias of hideUnspoken", () => {
    expect(parseSearchPatch({ hideEnglish: false })).toEqual({ hideUnspoken: false });
    expect(parseSearchPatch({ hideEnglish: true, maxDays: 3 })).toEqual({ hideUnspoken: true, maxDays: 3 });
    expect(parseSearchPatch({ hideEnglish: false, hideUnspoken: true })).toEqual({ hideUnspoken: true });
    expect(parseSearchPatch({ hideEnglish: "no" })).toBeNull();
  });

  test("rejects out-of-range, wrong types and unknown keys", () => {
    for (const bad of [
      null, [], "x", {}, { maxDays: 0 }, { maxDays: 91 }, { maxDays: 1.5 }, { maxDays: "7" },
      { minSalaryMxn: -1 }, { minSalaryMxn: 1_000_001 }, { minSalaryMxn: NaN },
      { hideEnglish: "yes" }, { hideUnspoken: "yes" }, { includeUndated: 1 }, { includeUnpublishedSalary: null },
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
    expect(s.hideUnspoken).toBe(false); // migrated from the old hideEnglish key
  });

  test("An older saved settings.json (hideEnglish only) keep working and migrate on save", () => {
    const root = tempRoot();
    mkdirSync(join(root, "ui", "state"), { recursive: true });
    writeFileSync(settingsPath(root), JSON.stringify({ currentSalary: 25000, targetSalary: 45000, search: { maxDays: 7, hideEnglish: true } }));
    const s = loadSearchSettings(root);
    expect(s.hideUnspoken).toBe(true);
    saveSearchSettings(root, s);
    const saved = JSON.parse(readFileSync(settingsPath(root), "utf8"));
    expect(saved.search.hideUnspoken).toBe(true);
    expect("hideEnglish" in saved.search).toBe(false);
    expect(saved.currentSalary).toBe(25000);
  });

  test("hideUnspoken wins over a stale hideEnglish and a bad value falls back", () => {
    const root = tempRoot();
    mkdirSync(join(root, "ui", "state"), { recursive: true });
    writeFileSync(settingsPath(root), JSON.stringify({ search: { hideEnglish: true, hideUnspoken: false } }));
    expect(loadSearchSettings(root).hideUnspoken).toBe(false);
    writeFileSync(settingsPath(root), JSON.stringify({ search: { hideEnglish: false, hideUnspoken: "x" } }));
    expect(loadSearchSettings(root).hideUnspoken).toBe(true); // invalid new value: the default, not the stale alias
    writeFileSync(settingsPath(root), JSON.stringify({ search: { hideUnspoken: "x" } }));
    expect(loadSearchSettings(root).hideUnspoken).toBe(true);
  });
});

describe("/api/jobs language filter follows profile_config.json", () => {
  function rootWith(languages: unknown[] | null) {
    const root = tempRoot();
    const path = join(root, "job_scraper", "seen_jobs.json");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    doc.seen["https://www.getonbrd.com/jobs/backend-python-acme"].posting_language = "en";
    doc.seen["https://himalayas.app/jobs/data-engineer-old"].posting_language = "de";
    writeFileSync(path, JSON.stringify(doc));
    if (languages) writeFileSync(join(root, "profile_config.json"), JSON.stringify({ name: "X", languages }));
    return root;
  }
  async function ranked(root: string, query = "") {
    const prev = process.env.JOB_SEARCH_PROFILE_CONFIG;
    delete process.env.JOB_SEARCH_PROFILE_CONFIG;
    try {
      const h = createHandler({ root });
      const data = await (await get(h, `/api/jobs?maxDays=365&minSalary=0&includeNoSalary=1&includeUndated=1${query}`)).json();
      return (data.ranked as { key: string }[]).map((j) => j.key);
    } finally {
      if (prev !== undefined) process.env.JOB_SEARCH_PROFILE_CONFIG = prev;
    }
  }
  const EN = "https://www.getonbrd.com/jobs/backend-python-acme";
  const DE = "https://himalayas.app/jobs/data-engineer-old";

  test("a A2-speaker profile hides English and German postings", async () => {
    const got = await ranked(rootWith([{ language: "Spanish", read: "native", write: "native", speak: "native" }, { language: "English", read: "B2", write: "B2", speak: "A2" }]));
    expect(got).not.toContain(EN);
    expect(got).not.toContain(DE);
  });

  test("English C1 + German B2 hides neither; turning the filter off shows both for the A2 speaker", async () => {
    const friend = await ranked(rootWith([{ language: "English", read: "C1", write: "C1", speak: "C1" }, { language: "German", read: "B2", write: "B2", speak: "B2" }]));
    expect(friend).toContain(EN);
    expect(friend).toContain(DE);
    const a2Off = await ranked(rootWith(null), "&hideUnspoken=0");
    expect(a2Off).toContain(EN);
    expect(a2Off).toContain(DE);
    expect(await ranked(rootWith(null), "&hideEnglish=1")).not.toContain(EN); // old URL parameter
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
    await post(h, "/api/search-settings", { maxDays: 33, minSalaryMxn: 12345, hideUnspoken: false, includeUndated: false, includeUnpublishedSalary: false, modalities: ["remote"] });
    const data = await (await get(h, "/api/jobs")).json();
    expect(data.filters).toEqual({
      maxDays: 33, minSalaryMxn: 12345, includeNoSalary: false, includeUndated: false, hideUnspoken: false, modalities: ["remote"],
    });
    const explicit = await (await get(h, "/api/jobs?maxDays=2")).json();
    expect(explicit.filters.maxDays).toBe(2);
    expect(explicit.filters.minSalaryMxn).toBe(12345);
  });
});
