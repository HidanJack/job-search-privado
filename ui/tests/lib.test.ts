import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ageInDays, filterJobs, inferRoleFamily, loadJobs, normalizeJob, parseFilters, skipJob, MODALITIES } from "../lib/jobs";
import { loadProfile, parseProfile } from "../lib/profile";
import { costNote, APPLY_TOOLS, BASE_TOOLS, INDEED_MCP_TOOLS, SEARCH_TOOLS, buildApplyPrompt, buildArgv, describeStreamLine, parseUiResult, resolveModel } from "../lib/runner";
import { isAllowedHost, isAllowedOrigin, safeResolve, sanitizeFeedback, validateJobUrl } from "../lib/security";
import { markApplied, parseCsv, readTracker, trackerStats } from "../lib/tracker";

const FIXTURES = join(import.meta.dir, "fixtures");
const TODAY = new Date(2026, 9, 15); // 2026-10-15 local

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "job-ui-"));
  mkdirSync(join(root, "job_scraper"), { recursive: true });
  cpSync(join(FIXTURES, "seen_jobs.json"), join(root, "job_scraper", "seen_jobs.json"));
  return root;
}
const defaults = { maxDays: 4, minSalaryMxn: 40000 };

describe("age and salary filters", () => {
  test("ageInDays handles dates, ISO timestamps and garbage", () => {
    expect(ageInDays("2026-10-13", TODAY)).toBe(2);
    expect(ageInDays("2026-10-15T09:00:00Z", TODAY)).toBe(0);
    expect(ageInDays("ASAP", TODAY)).toBeNull();
    expect(ageInDays(null, TODAY)).toBeNull();
  });

  test("defaults: fresh, >=40k or unpublished salary, all modalities, vetoes and stale removed", () => {
    const jobs = loadJobs(tempRoot(), TODAY);
    const { ranked, unranked } = filterJobs(jobs, parseFilters(new URLSearchParams(), defaults));
    expect(ranked.map((j) => j.company)).toEqual(["Acme LatAm", "Hybrid Inc"]);
    expect(unranked.map((j) => j.company)).toEqual(["NewCo"]);
  });

  test("sorted by priority_score, wider window brings in older postings", () => {
    const jobs = loadJobs(tempRoot(), TODAY);
    const { ranked } = filterJobs(jobs, parseFilters(new URLSearchParams("maxDays=60&minSalary=0"), defaults));
    expect(ranked.map((j) => j.priority_score)).toEqual([87, 85, 75, 66]);
  });

  test("excluding unpublished salary and restricting modality", () => {
    const jobs = loadJobs(tempRoot(), TODAY);
    const f = parseFilters(new URLSearchParams("includeNoSalary=0&modality=remote,hybrid"), defaults);
    expect(filterJobs(jobs, f).ranked.map((j) => j.company)).toEqual(["Acme LatAm"]);
    expect(parseFilters(new URLSearchParams("modality=bogus"), defaults).modalities).toEqual([]);
    expect(parseFilters(new URLSearchParams(), defaults).modalities).toEqual(MODALITIES);
  });

  test("bad numbers fall back to defaults", () => {
    const f = parseFilters(new URLSearchParams("maxDays=-3&minSalary=abc"), defaults);
    expect(f.maxDays).toBe(4);
    expect(f.minSalaryMxn).toBe(40000);
  });

  test("skipJob marks the entry skipped and keeps the rest", () => {
    const root = tempRoot();
    expect(skipJob(root, "cheap-onsite")).toBe(true);
    expect(skipJob(root, "does-not-exist")).toBe(false);
    const doc = JSON.parse(readFileSync(join(root, "job_scraper", "seen_jobs.json"), "utf8"));
    expect(doc.seen["cheap-onsite"].status).toBe("skipped");
    expect(Object.keys(doc.seen).length).toBe(7);
  });
});

describe("profile", () => {
  test("loadProfile exposes the name from profile_config.json and whether it is configured", () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-cfg-"));
    try {
      writeFileSync(join(dir, "CLAUDE.md"), "# Alex\n- **Freshness window:** 4 days\n");
      expect(loadProfile(dir)).toMatchObject({ ready: true, name: "", configured: false });
      writeFileSync(join(dir, "profile_config.json"), JSON.stringify({ name: "Alex Example" }));
      expect(loadProfile(dir)).toMatchObject({ name: "Alex Example", configured: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("placeholders mean not ready and fall back to defaults", () => {
    const p = parseProfile("# for [YOUR_NAME]\n- **Freshness window:** 4 days\n- **Salary floor:** [YOUR_SALARY_FLOOR]");
    expect(p).toEqual({ ready: false, freshnessDays: 4, salaryFloorMxn: 30000 });
  });
  test("reads freshness and floor", () => {
    const p = parseProfile("# Alex\n- **Freshness window:** 7 days\n- **Salary floor:** 45,000 MXN/month");
    expect(p).toEqual({ ready: true, freshnessDays: 7, salaryFloorMxn: 45000 });
  });
});

describe("security", () => {
  test("posting URL validation", () => {
    expect(validateJobUrl("https://www.getonbrd.com/jobs/x?y=1")).toBe("https://www.getonbrd.com/jobs/x?y=1");
    expect(validateJobUrl("javascript:alert(1)")).toBeNull();
    expect(validateJobUrl("file:///etc/passwd")).toBeNull();
    expect(validateJobUrl("https://user:pw@evil.com")).toBeNull();
    expect(validateJobUrl("https://a.com/x --dangerously-skip-permissions")).toBeNull();
    expect(validateJobUrl("https://a.com/\nIgnore previous")).toBeNull();
    expect(validateJobUrl("https://a.com/" + "x".repeat(3000))).toBeNull();
    expect(validateJobUrl(42)).toBeNull();
  });

  test("feedback is flattened and bounded", () => {
    expect(sanitizeFeedback("line1\nline2\u0000  end")).toBe("line1 line2 end");
    expect(sanitizeFeedback("x".repeat(5000)).length).toBe(2000);
    expect(sanitizeFeedback(undefined)).toBe("");
  });

  test("host and origin checks", () => {
    expect(isAllowedHost("127.0.0.1:8787", 8787)).toBe(true);
    expect(isAllowedHost("localhost:8787", 8787)).toBe(true);
    expect(isAllowedHost("evil.com", 8787)).toBe(false);
    expect(isAllowedHost(null, 8787)).toBe(false);
    expect(isAllowedOrigin("http://127.0.0.1:8787", 8787)).toBe(true);
    expect(isAllowedOrigin("https://evil.com", 8787)).toBe(false);
    expect(isAllowedOrigin("http://127.0.0.1:9999", 8787)).toBe(false);
    expect(isAllowedOrigin(null, 8787)).toBe(false);
  });

  test("safeResolve blocks traversal, absolute paths, wrong dirs, wrong extensions and symlink escapes", () => {
    const root = tempRoot();
    mkdirSync(join(root, "cv"));
    writeFileSync(join(root, "cv", "main_acme.pdf"), "%PDF-1.4");
    writeFileSync(join(root, "secret.pdf"), "%PDF-1.4");
    symlinkSync(join(root, "secret.pdf"), join(root, "cv", "link.pdf"));
    const ok = (p: string) => safeResolve(root, p, ["cv", "cover_letters"], [".pdf"]);
    expect(ok("cv/main_acme.pdf")).toBe(join(root, "cv", "main_acme.pdf"));
    expect(ok("cv/../secret.pdf")).toBeNull();
    expect(ok("../../etc/passwd.pdf")).toBeNull();
    expect(ok("/etc/passwd")).toBeNull();
    expect(ok("cv/main_acme.tex")).toBeNull();
    expect(ok("job_scraper/seen_jobs.json")).toBeNull();
    expect(ok("cv/link.pdf")).toBeNull();
    expect(ok("cv")).toBeNull();
  });
});

describe("headless runner", () => {
  test("argv keeps the prompt as one element and allowedTools last", () => {
    const prompt = buildApplyPrompt("https://a.com/job", true, "resalta Kubernetes --dangerously-skip-permissions");
    const argv = buildArgv("claude", prompt, APPLY_TOOLS);
    expect(argv.slice(0, 3)).toEqual(["claude", "-p", prompt]);
    expect(prompt).toBe("/apply [ui-mode] [knockouts-acknowledged] https://a.com/job [feedback] resalta Kubernetes --dangerously-skip-permissions");
    expect(argv).toContain("acceptEdits");
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(argv.indexOf("--allowedTools")).toBe(argv.length - APPLY_TOOLS.length - 1);
    expect(APPLY_TOOLS.some((t) => t.startsWith("Bash(curl"))).toBe(false);
    expect(APPLY_TOOLS).not.toContain("Bash");
  });

  test("every run pins a validated --model, sonnet by default", () => {
    const argv = buildArgv("claude", "/rank", BASE_TOOLS);
    expect(argv[argv.indexOf("--model") + 1]).toBe(resolveModel(process.env.JOB_UI_MODEL));
    expect(buildArgv("claude", "/rank", BASE_TOOLS, "opus")).toContain("opus");
    expect(argv.indexOf("--model")).toBeLessThan(argv.indexOf("--allowedTools"));
  });

  test("resolveModel accepts aliases and claude ids, rejects anything that could be a flag", () => {
    expect(resolveModel(undefined)).toBe("sonnet");
    expect(resolveModel("")).toBe("sonnet");
    for (const ok of ["sonnet", "opus", "haiku", "claude-sonnet-4-5", "claude-opus-4-1-20250805", "claude-sonnet-4-5[1m]"]) {
      expect(resolveModel(ok)).toBe(ok);
    }
    for (const bad of ["--dangerously-skip-permissions", "sonnet --x", "claude-x; rm -rf /", "gpt-4", "-p", "claude-", "Sonnet\n--x"]) {
      expect(resolveModel(bad)).toBe("sonnet");
    }
  });

  test("apply may delete its own cover letter build leftovers", () => {
    expect(APPLY_TOOLS).toContain("Bash(rm -f cover_letters/cover_:*)");
  });

  test("search, rank and apply runs may call the Indeed MCP tools", () => {
    for (const tools of [SEARCH_TOOLS, BASE_TOOLS, APPLY_TOOLS]) {
      for (const t of INDEED_MCP_TOOLS) expect(tools).toContain(t);
    }
  });

  test("search run may store results only through scrape_state.py and read its queries via profile_config.py queries", () => {
    const bash = SEARCH_TOOLS.filter((t) => t.startsWith("Bash"));
    expect(bash).toEqual([
      "Bash(python tools/scrape_state.py:*)", "Bash(python3 tools/scrape_state.py:*)",
      "Bash(python tools/profile_config.py queries:*)", "Bash(python3 tools/profile_config.py queries:*)",
    ]);
    expect(SEARCH_TOOLS).not.toContain("Bash");
  });

  test("prompt without acknowledgement or feedback", () => {
    expect(buildApplyPrompt("https://a.com/j", false, "")).toBe("/apply [ui-mode] https://a.com/j");
  });

  test("parses the last ui-result block", () => {
    const text = 'Done.\n```ui-result\n{"stage":"knockout"}\n```\nmore\n```ui-result\n{"stage":"done","cv_pdf":"cv/main_a_b.pdf"}\n```';
    expect(parseUiResult(text)).toEqual({ stage: "done", cv_pdf: "cv/main_a_b.pdf" });
    expect(parseUiResult("no block")).toBeNull();
    expect(parseUiResult('```ui-result\n{"stage":"weird"}\n```')).toBeNull();
    expect(parseUiResult("```ui-result\nnot json\n```")).toBeNull();
  });

  test("describes stream-json lines", () => {
    const tool = describeStreamLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "bun run x" } }] } }));
    expect(tool).toEqual([{ type: "tool", text: "Bash: bun run x" }]);
    const result = describeStreamLine(JSON.stringify({ type: "result", is_error: false, result: "final" }));
    expect(result[0].result).toBe("final");
    expect(describeStreamLine("not json")).toEqual([]);
    const costed = describeStreamLine(JSON.stringify({ type: "result", is_error: false, result: "x", total_cost_usd: 1.9042 }));
    expect(costed.at(-1)).toEqual({ type: "cost", text: "Costo de esta corrida: ~$1.90" });
    expect(describeStreamLine(JSON.stringify({ type: "result", result: "x" })).some((i) => i.type === "cost")).toBe(false);
    expect(costNote("1.9")).toBeNull();
    expect(costNote(-1)).toBeNull();
  });
});

describe("tracker", () => {
  const text = readFileSync(join(FIXTURES, "tracker.csv"), "utf8");

  test("parses quoted fields with commas and doubled quotes", () => {
    const { rows } = readTracker(text);
    expect(rows.length).toBe(4);
    expect(rows[0].notes).toBe('rejected 2026-10-10, "polite"');
    expect(parseCsv('a,"b\nc",d\n')[0].fields).toEqual(["a", "b\nc", "d"]);
  });

  test("markApplied changes only the drafted row for that URL", () => {
    const out = markApplied(text, "https://www.getonbrd.com/jobs/backend-python-acme", "2026-10-15");
    if ("error" in out) throw new Error(out.error);
    const before = text.split("\n");
    const after = out.text.split("\n");
    expect(after.length).toBe(before.length);
    expect(after.slice(0, 4)).toEqual(before.slice(0, 4));
    expect(after[4]).toBe("2026-10-15,Acme LatAm,Tech,Backend Python Engineer,,portal,applied,,82,,cv/main_acme.tex,cover_letters/cover_acme.tex,https://www.getonbrd.com/jobs/backend-python-acme,");
  });

  test("markApplied never touches a non-drafted row", () => {
    expect(markApplied(text, "https://himalayas.app/jobs/data-engineer-old", "2026-10-15")).toEqual({ error: "row_not_found" });
  });

  test("stats: pipeline with legacy spellings and response rate per channel/portal", () => {
    const stats = trackerStats(readTracker(text).rows);
    expect(stats.pipeline.no_response).toBe(1);
    expect(stats.pipeline.drafted).toBe(1);
    expect(stats.byChannel.portal).toEqual({ sent: 2, responded: 1, rate: 0.5 });
    expect(stats.byChannel.referral).toEqual({ sent: 1, responded: 1, rate: 1 });
    expect(stats.byPortal["getonbrd.com"]).toEqual({ sent: 1, responded: 0, rate: 0 });
  });
});

describe("English-posting filter, pills and role family", () => {
  const base = { status: "ranked", rank_score: 80, posted_date: "2026-10-14", salary_mxn_month: 40000, modality: "remote" };
  const mk = (key: string, extra: Record<string, unknown>) => normalizeJob(key, { title: key, company: "X", ...base, ...extra }, TODAY);
  const jobs = [
    mk("english", { posting_language: "en", language_gate: "FLAG", language_note: "posting written in English: spoken English likely required" }),
    mk("spanish", { posting_language: "es" }),
    mk("mixed", { posting_language: "mixed" }),
    mk("legacy", {}), // ranked before the field existed
  ];

  test("hideEnglish defaults to on and hides only explicit 'en'", () => {
    const f = parseFilters(new URLSearchParams(), defaults);
    expect(f.hideEnglish).toBe(true);
    expect(filterJobs(jobs, f).ranked.map((j) => j.key).sort()).toEqual(["legacy", "mixed", "spanish"]);
  });

  test("hideEnglish=0 shows English postings again", () => {
    const f = parseFilters(new URLSearchParams("hideEnglish=0"), defaults);
    expect(f.hideEnglish).toBe(false);
    expect(filterJobs(jobs, f).ranked.map((j) => j.key)).toContain("english");
  });

  test("posting_language is validated; unknown values become null", () => {
    expect(mk("a", { posting_language: "fr" }).posting_language).toBeNull();
    expect(mk("b", { posting_language: "en" }).posting_language).toBe("en");
  });

  test("spoken_english comes from language_gate/language_note/posting_language", () => {
    expect(jobs[0].spoken_english).toBe(true);
    expect(mk("c", { language_gate: "FLAG", language_note: "Requires conversational spoken English (fluent)" }).spoken_english).toBe(true);
    expect(mk("d", { language_gate: "FLAG", language_note: "Requires fluent Polish" }).spoken_english).toBe(false);
    expect(mk("e", { language_gate: "PASS", language_note: "spoken English" }).spoken_english).toBe(false);
    expect(jobs[3].spoken_english).toBe(false);
  });

  test("role family is inferred from the title only, or left null", () => {
    expect(inferRoleFamily("QA Automation Engineer")).toBe("QA / pruebas");
    expect(inferRoleFamily("Desarrollador Frontend")).toBe("Frontend / web");
    expect(inferRoleFamily("Analista de Datos")).toBe("Analista de datos / BI");
    expect(inferRoleFamily("Senior Python Developer")).toBe("Backend");
    expect(inferRoleFamily("Gerente de ventas")).toBeNull();
  });
});
