import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROFILE_CONFIG, isConfigFilled, loadProfileConfig } from "../lib/profile_config";

const dirs: string[] = [];
const root = (doc?: unknown) => {
  const d = mkdtempSync(join(tmpdir(), "pcfg-"));
  dirs.push(d);
  if (doc !== undefined) writeFileSync(join(d, "profile_config.json"), typeof doc === "string" ? doc : JSON.stringify(doc));
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("profile_config", () => {
  test("missing file: neutral defaults, not filled in", () => {
    const c = loadProfileConfig(root());
    expect(c).toEqual(DEFAULT_PROFILE_CONFIG);
    expect(c.name).toBe("");
    expect(isConfigFilled(c)).toBe(false);
  });

  test("malformed or non-object JSON falls back to defaults", () => {
    expect(loadProfileConfig(root("{nope"))).toEqual(DEFAULT_PROFILE_CONFIG);
    expect(loadProfileConfig(root([1]))).toEqual(DEFAULT_PROFILE_CONFIG);
  });

  test("valid values override, invalid ones are ignored key by key", () => {
    const c = loadProfileConfig(root({
      name: "Alex Example", salary_floor_mxn: 50000, current_salary_mxn: -4,
      skills: { selected: ["python", "rust"], combo_partners: "bad", primary: "rust" },
    }));
    expect(c.name).toBe("Alex Example");
    expect(c.salary_floor_mxn).toBe(50000);
    expect(c.current_salary_mxn).toBe(DEFAULT_PROFILE_CONFIG.current_salary_mxn);
    expect(c.skills.selected).toEqual(["python", "rust"]);
    expect(c.skills.combo_partners).toEqual(DEFAULT_PROFILE_CONFIG.skills.combo_partners);
    expect(c.skills.primary).toBe("rust");
    expect(isConfigFilled(c)).toBe(true);
  });

  test("defaults are not shared between calls", () => {
    const a = loadProfileConfig(root());
    a.skills.selected.push("zzz");
    expect(loadProfileConfig(root()).skills.selected).not.toContain("zzz");
  });

  test("languages: valid entries kept, invalid levels become null, junk dropped", () => {
    const c = loadProfileConfig(root({ languages: [
      { language: "English", read: "b2", write: "B2", speak: "fluent" }, { language: "" }, "x",
      { language: "Spanish", read: "native", write: "native", speak: "native" },
    ] }));
    expect(c.languages).toEqual([
      { language: "English", read: "B2", write: "B2", speak: null },
      { language: "Spanish", read: "native", write: "native", speak: "native" },
    ]);
    expect(DEFAULT_PROFILE_CONFIG.languages).toEqual([]);
  });

  test("search.families: valid ones replace the defaults, unusable ones fall back", () => {
    const good = { name: "Backend", queries: [{ text: "python  backend", lang: "EN" }, { text: "--latam", lang: "en" }, { text: "x", lang: "english" }] };
    const c = loadProfileConfig(root({ search: { families: [good, { name: "", queries: [] }, "junk"] } }));
    expect(c.search.families).toEqual([{ name: "Backend", queries: [{ text: "python backend", lang: "en" }] }]);
    for (const bad of ["x", [], [{ name: "A", queries: [] }]]) {
      expect(loadProfileConfig(root({ search: { families: bad } })).search.families).toEqual(DEFAULT_PROFILE_CONFIG.search.families);
    }
  });

  test("search.families keeps optional indeed/broad fields", () => {
    const c = loadProfileConfig(root({ search: { families: [{ name: "W", queries: [], indeed: ["desarrollador web"], broad: true }] } }));
    expect(c.search.families).toEqual([{ name: "W", queries: [], indeed: ["desarrollador web"], broad: true }]);
  });
});
