import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { filterJobs, normalizeJob, parseFilters, type Job } from "../lib/jobs";
import { parseRequirements, requirementAssessment, userLevels, type LanguageRequirement } from "../lib/language_levels";

const A2 = [
  { language: "Spanish", read: "native", write: "native", speak: "native" },
  { language: "English", read: "B2", write: "B2", speak: "A2" },
] as never;
const TODAY = new Date(2026, 9, 28);
const req = (kind: string, skill = "any", level: string | null = null, evidence: string | null = null, optional = false): LanguageRequirement =>
  ({ lang: "en", skill, level, kind, evidence, source: "regex", ...(optional ? { optional: true } : {}) }) as LanguageRequirement;
const assess = (reqs: LanguageRequirement[] | null, posting = "en") => requirementAssessment(posting, reqs, userLevels(A2));

describe("requirementAssessment", () => {
  test("conversational is a spoken flag quoting the evidence", () => {
    const a = assess([req("conversational", "speak", null, "Conversational English is required")]);
    expect([a.need, a.verdict, a.riskFactor]).toEqual(["spoken", "FLAG", 1]);
    expect(a.note).toBe("Piden inglés conversacional: «Conversational English is required». Tu nivel hablado es A2.");
  });
  test("read/write within the candidate's level passes", () => {
    const a = assess([req("technical_read_write", "read_write")]);
    expect([a.need, a.verdict, a.riskFactor]).toEqual(["read_write", "PASS", 0]);
    expect(a.note).toBe("Piden inglés de lectura/escritura (B2): lo cubres.");
    expect(assess([req("intermediate")]).need).toBe("read_write");
    expect(assess([req("advanced", "read_write", "C1")]).need).toBe("spoken");
  });
  test("a plus passes, unspecified is a soft flag with half the risk", () => {
    expect(assess([req("fluent", "speak", null, null, true)]).need).toBe("optional");
    const u = assess([req("unspecified")]);
    expect([u.need, u.verdict, u.riskFactor]).toEqual(["unspecified", "FLAG", 0.5]);
    expect(u.note).toBe("No especifica el nivel; probablemente hay reuniones en inglés.");
  });
  test("spanish, mixed and other languages", () => {
    for (const p of ["es", "mixed", "unknown"]) expect(assess([req("fluent", "speak")], p).need).toBe("none");
    expect(assess([{ ...req("fluent", "speak"), lang: "de" }]).need).toBe("unspecified");
  });
  test("never analysed keeps the old rule", () => {
    const a = assess(null);
    expect([a.legacy, a.need]).toEqual([true, "spoken"]);
    expect(requirementAssessment("en", null, userLevels([{ language: "English", read: "B2", write: "B2", speak: "B1" }] as never)).need).toBe("unspecified");
  });
  test("an earlier assumption is kept as a source and behaves as unspecified", () => {
    const parsed = parseRequirements([{ lang: "en", skill: "any", kind: "unspecified", source: "llm_assumption" }]);
    expect(parsed?.[0].source).toBe("llm_assumption");
    expect(assess(parsed).need).toBe("unspecified");
  });
  test("parseRequirements is defensive", () => {
    expect(parseRequirements(undefined)).toBeNull();
    expect(parseRequirements([{ lang: "xx" }, "junk", { lang: "en", skill: "bogus", kind: "nope", level: "native", evidence: 5 }])).toEqual([
      { lang: "en", skill: "any", level: null, kind: "unspecified", evidence: null, source: "regex" },
    ]);
  });
});

describe("parity with tools/language_levels.py", () => {
  const cases: [string, LanguageRequirement[]][] = [
    ["en", [req("conversational", "speak", null, "Conversational English")]],
    ["en", [req("technical_read_write", "read_write")]],
    ["en", [req("intermediate", "speak", "B1")]],
    ["en", [req("advanced", "any", "C1")]],
    ["en", [req("basic", "any", null, null, true)]],
    ["en", [req("unspecified")]],
    ["en", []],
    ["es", [req("fluent", "speak")]],
    ["en", [req("technical_read_write", "read_write"), req("fluent", "speak", null, "Fluent English")]],
  ];
  test("same need, verdict, note and risk factor", () => {
    const script = `
import json,sys
sys.path.insert(0,"tools")
import language_levels as ll
lv=ll.user_levels({"languages":[{"language":"Spanish","read":"native","write":"native","speak":"native"},{"language":"English","read":"B2","write":"B2","speak":"A2"}]})
out=[]
for posting,reqs in json.load(sys.stdin):
    a=ll.requirement_assessment(posting,reqs,lv)
    out.append([a["need"],a["verdict"],a["note"],a["risk_factor"]])
print(json.dumps(out,ensure_ascii=False))`;
    const proc = Bun.spawnSync(["python3", "-c", script], { cwd: join(import.meta.dir, "..", ".."), stdin: new TextEncoder().encode(JSON.stringify(cases)) });
    expect(proc.exitCode).toBe(0);
    const py = JSON.parse(proc.stdout.toString());
    const ts = cases.map(([p, r]) => { const a = assess(r, p); return [a.need, a.verdict, a.note, a.riskFactor]; });
    expect(ts).toEqual(py);
  });
});

describe("filterJobs with real requirements", () => {
  const mk = (key: string, over: Record<string, unknown>): Job =>
    normalizeJob(key, {
      title: key, company: `Co ${key}`, status: "ranked", posted_date: "2026-10-27", modality: "remote", salary_mxn_month: 50000,
      posting_language: "en", rank_score: 70, ...over,
    }, TODAY);
  const jobs = [
    mk("fluent", { language_requirements: [req("fluent", "speak", null, "Fluent English required")] }),
    mk("intermediate", { language_requirements: [req("intermediate")] }),
    mk("readwrite", { language_requirements: [req("technical_read_write", "read_write", null, "read and write technical English")] }),
    mk("unspecified", { language_requirements: [req("unspecified")] }),
    mk("plus", { language_requirements: [req("basic", "any", null, "English is a plus", true)] }),
    mk("spanish", { posting_language: "es", language_requirements: [] }),
    mk("legacy", {}),
  ];
  const f = (q = "") => parseFilters(new URLSearchParams(q), { maxDays: 30, minSalaryMxn: 0 });
  const keys = (q = "") => filterJobs(jobs, f(q), A2).ranked.map((j) => j.key).sort();

  test("by default only explicit spoken requirements (and never-analysed English) are hidden", () => {
    expect(f().hideSpokenGap).toBe(true);
    expect(keys()).toEqual(["intermediate", "plus", "readwrite", "spanish", "unspecified"]);
  });
  test("filter off shows everything", () => {
    expect(keys("hideSpokenGap=0")).toHaveLength(7);
  });
  test("the needs and evidence are attached for the chips", () => {
    const got = Object.fromEntries(filterJobs(jobs, f("hideSpokenGap=0"), A2).ranked.map((j) => [j.key, [j.language_need, j.language_evidence]]));
    expect(got.fluent).toEqual(["spoken", "Fluent English required"]);
    expect(got.readwrite).toEqual(["read_write", "read and write technical English"]);
    expect(got.unspecified[0]).toBe("unspecified");
    expect(got.plus[0]).toBe("optional");
    expect(got.spanish[0]).toBe("none");
  });
  test("a soft flag for an unspecified level is not a spoken-language gap", () => {
    const j = normalizeJob("u", { title: "u", status: "ranked", posting_language: "en", language_gate: "FLAG", language_note: "No especifica el nivel; probablemente hay reuniones en inglés.", language_requirements: [req("unspecified")] }, TODAY);
    expect(j.spoken_language).toBe("en");   // raw derivation from the gate
    const shown = filterJobs([j], f("hideSpokenGap=0&minSalary=0&maxDays=365"), A2).ranked[0];
    expect([shown.language_need, shown.spoken_language, shown.spoken_english]).toEqual(["unspecified", null, false]);
  });
  test("aliases of the filter parameter", () => {
    expect(f("hideUnspoken=0").hideSpokenGap).toBe(false);
    expect(f("hideEnglish=0").hideSpokenGap).toBe(false);
    expect(f("hideSpokenGap=0&hideUnspoken=1").hideSpokenGap).toBe(false);
  });
});

describe("blocked companies", () => {
  const mk = (key: string, company: string, status = "ranked"): Job =>
    normalizeJob(key, { title: key, company, status, posted_date: "2026-10-27", modality: "remote", salary_mxn_month: 50000, posting_language: "es", rank_score: 70 }, TODAY);
  const jobs = [mk("a", "Acme Spam Corp"), mk("b", "Fine Co"), mk("c", "Acme Spam, S.A. de C.V.", "new")];
  test("hidden from ranked and pending, not deleted", () => {
    const blocked = [{ name: "Acme Spam", aliases: [], added: "2026-10-28" }];
    const out = filterJobs(jobs, parseFilters(new URLSearchParams(), { maxDays: 30, minSalaryMxn: 0 }), undefined, blocked);
    expect(out.ranked.map((j) => j.key)).toEqual(["b"]);
    expect(out.unranked).toEqual([]);
    expect(jobs).toHaveLength(3);
  });
});
