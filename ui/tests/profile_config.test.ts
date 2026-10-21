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
});
