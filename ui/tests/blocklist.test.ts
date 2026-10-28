import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addBlocked, findBlocked, isBlocked, normalizeCompany, parseBlockedCompanies, parseNewEntry, readBlocked, removeBlocked,
  suggestCompanies, BlocklistError, type BlockedCompany,
} from "../lib/blocklist";
import { parseProfileConfig } from "../lib/profile_config";

const e = (name: string, aliases: string[] = []): BlockedCompany => ({ name, aliases, added: "2026-10-28" });

describe("normalizeCompany", () => {
  test("case, accents, punctuation and legal suffixes", () => {
    expect(normalizeCompany("  Ácme-Spam,  CORP. ")).toBe("acme spam");
    for (const raw of ["Acme Spam Corp S.A. de C.V.", "Acme Spam, Inc.", "ACME SPAM LLC", "Acme Spam Ltd", "Acme Spam S.A.", "Acme Spam SA de CV"]) {
      expect(normalizeCompany(raw)).toBe("acme spam");
    }
    expect(normalizeCompany("Inc")).toBe("inc");
    expect(normalizeCompany(null)).toBe("");
  });
});

describe("findBlocked", () => {
  test("equality, alias and whole-word containment", () => {
    expect(isBlocked("ACME SPAM, S.A. de C.V.", [e("Acme Spam Corp")])).toBe(true);
    expect(findBlocked("Baires Dev Inc", [e("Baires Corp", ["Baires Dev"])])?.name).toBe("Baires Corp");
    expect(isBlocked("TV Spam Deportes", [e("TV Spam")])).toBe(true);
    expect(isBlocked("Grupo TV Spam", [e("TV Spam")])).toBe(true);
  });
  test("partial words and shared single words do not match", () => {
    expect(isBlocked("Spamalot Studios", [e("Spam")])).toBe(false);
    expect(isBlocked("Antispam Labs", [e("Spam")])).toBe(false);
    expect(isBlocked("Spam Tech Solutions", [e("TV Spam"), e("Banco Spam")])).toBe(false);
    expect(isBlocked("Banco Nacional", [e("Banco Spam")])).toBe(false);
    expect(isBlocked(null, [e("Acme")])).toBe(false);
    expect(isBlocked("Acme", [])).toBe(false);
  });
});

describe("parseBlockedCompanies", () => {
  test("validates, caps and dedupes", () => {
    const out = parseBlockedCompanies([
      { name: "Acme Spam", aliases: ["Acme", 7, "  "], reason: "x".repeat(500), added: "2026-10-28" },
      { name: "acme spam inc" }, { name: "" }, "junk", { aliases: ["z"] }, { name: "Other", added: "28/10/2026" },
    ]);
    expect(out.map((x) => x.name)).toEqual(["Acme Spam", "Other"]);
    expect(out[0].aliases).toEqual(["Acme"]);
    expect(out[0].reason!.length).toBeLessThanOrEqual(200);
    expect(out[1].added).toBeNull();
    expect(parseBlockedCompanies(null)).toEqual([]);
  });
  test("profile config carries the list and defaults to empty", () => {
    expect(parseProfileConfig({ blocked_companies: [{ name: "Acme Spam" }] }).blocked_companies[0].name).toBe("Acme Spam");
    expect(parseProfileConfig({}).blocked_companies).toEqual([]);
  });
});

describe("parseNewEntry", () => {
  test("rejects bad input with a Spanish message", () => {
    for (const body of [{}, { name: "" }, { name: "x".repeat(81) }, { name: "...." }, { name: "A", aliases: "B" }, { name: "A", reason: 5 }]) {
      expect(() => parseNewEntry(body as never, "2026-10-28")).toThrow(BlocklistError);
    }
    const ok = parseNewEntry({ name: "  Acme   Spam ", aliases: ["Acme"], reason: "basura" }, "2026-10-28");
    expect(ok).toEqual({ name: "Acme Spam", aliases: ["Acme"], reason: "basura", added: "2026-10-28" });
  });
});

describe("store", () => {
  function rootWith(config: unknown) {
    const root = mkdtempSync(join(tmpdir(), "job-blk-"));
    if (config !== null) writeFileSync(join(root, "profile_config.json"), JSON.stringify(config));
    return root;
  }
  const run = (fn: () => void) => {
    const prev = process.env.JOB_SEARCH_PROFILE_CONFIG;
    delete process.env.JOB_SEARCH_PROFILE_CONFIG;
    try { fn(); } finally { if (prev !== undefined) process.env.JOB_SEARCH_PROFILE_CONFIG = prev; }
  };

  test("add keeps the other keys, backs up the previous file and is idempotent", () => run(() => {
    const root = rootWith({ name: "X", candidate_years: 3, blocked_companies: [] });
    const first = addBlocked(root, e("Acme Spam"));
    expect(first.added).toBe(true);
    const doc = JSON.parse(readFileSync(join(root, "profile_config.json"), "utf8"));
    expect(doc.name).toBe("X");
    expect(doc.candidate_years).toBe(3);
    expect(doc.blocked_companies.map((b: BlockedCompany) => b.name)).toEqual(["Acme Spam"]);
    const backups = readdirSync(join(root, "ui", "state", "backups"));
    expect(backups.length).toBe(1);
    expect(JSON.parse(readFileSync(join(root, "ui", "state", "backups", backups[0]), "utf8")).blocked_companies).toEqual([]);
    expect(addBlocked(root, e("ACME SPAM inc")).added).toBe(false);
    expect(readBlocked(root).length).toBe(1);
  }));

  test("works without a config file and remove deletes by normalized name", () => run(() => {
    const root = rootWith(null);
    addBlocked(root, e("Acme Spam"));
    expect(existsSync(join(root, "ui", "state", "backups"))).toBe(false); // nothing to back up
    expect(removeBlocked(root, "acme spam, inc.").removed).toBe(true);
    expect(removeBlocked(root, "nope").removed).toBe(false);
    expect(readBlocked(root)).toEqual([]);
  }));

  test("a corrupt config is not overwritten", () => run(() => {
    const root = rootWith(null);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "profile_config.json"), "{not json");
    expect(() => addBlocked(root, e("Acme"))).toThrow();
    expect(readFileSync(join(root, "profile_config.json"), "utf8")).toBe("{not json");
  }));
});

describe("suggestCompanies", () => {
  const many = (company: string, n: number, age: number, extra: object = {}) =>
    Array.from({ length: n }, () => ({ company, age_days: age, ...extra }));
  test("stale or reposted companies with enough postings, never blocked ones", () => {
    const jobs = [...many("Old Postings Co", 5, 60), ...many("Old Postings Co S.A. de C.V.", 4, 60), ...many("Fresh Co", 9, 3), ...many("Few Co", 3, 90), ...many("Repost Co", 10, 3, { reposted: true })];
    const out = suggestCompanies(jobs, []);
    expect(out.map((s) => s.company)).toEqual(["Repost Co", "Old Postings Co"]);
    expect(out.find((s) => s.company === "Old Postings Co")?.count).toBe(9);
    expect(out.map((s) => s.company)).not.toContain("Fresh Co");
    expect(out.map((s) => s.company)).not.toContain("Few Co");
    expect(suggestCompanies(jobs, [e("Old Postings Co")]).map((s) => s.company)).toEqual(["Repost Co"]);
  });
});
