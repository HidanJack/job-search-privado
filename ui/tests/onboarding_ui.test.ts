import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Pure helpers behind the first-run screens (public/onboarding-logic.js).
// @ts-ignore plain browser module, no declaration file
const L: any = await import("../public/onboarding-logic.js");
const PROPOSAL = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "tests", "fixtures", "onboarding_proposal.json"), "utf8"));

describe("entry validation", () => {
  test("needs a file or some text", () => {
    expect(L.validateEntry({ fileName: "", fileSize: 0, text: "  " }).ok).toBe(false);
    expect(L.validateEntry({ fileName: "", fileSize: 0, text: "Soy dev" }).ok).toBe(true);
    expect(L.validateEntry({ fileName: "cv.pdf", fileSize: 1000, text: "" }).ok).toBe(true);
  });
  test("file type and size", () => {
    expect(L.validateEntry({ fileName: "cv.exe", fileSize: 10, text: "" }).error).toMatch(/PDF, DOCX, TXT o MD/);
    expect(L.validateEntry({ fileName: "CV.DOCX", fileSize: 10, text: "" }).ok).toBe(true);
    expect(L.validateEntry({ fileName: "cv.pdf", fileSize: 2 * 1024 * 1024 + 1, text: "" }).error).toMatch(/2 MB/);
    expect(L.validateEntry({ fileName: "cv.pdf", fileSize: 0, text: "" }).error).toMatch(/vacío/);
  });
  test("text length", () => {
    expect(L.validateEntry({ fileName: "", fileSize: 0, text: "a".repeat(20000) }).ok).toBe(true);
    expect(L.validateEntry({ fileName: "", fileSize: 0, text: "a".repeat(20001) }).error).toMatch(/20,000/);
  });
});

describe("answers", () => {
  test("language rows become 'Alemán B2' strings, blanks dropped, duplicates merged", () => {
    expect(
      L.languagesToAnswers([
        { language: " Alemán ", level: "B2" },
        { language: "", level: "C1" },
        { language: "alemán", level: "A1" },
        { language: "Inglés", level: "native" },
        { language: "Francés", level: "" },
      ]),
    ).toEqual(["Alemán B2", "Inglés nativo", "Francés"]);
  });
  test("salary parsing", () => {
    expect(L.parseSalary("")).toEqual({ value: null });
    expect(L.parseSalary("$45,000")).toEqual({ value: 45000 });
    expect(L.parseSalary("45 000")).toEqual({ value: 45000 });
    expect(L.parseSalary("4500.5").error).toBeTruthy();
    expect(L.parseSalary("0").error).toBeTruthy();
    expect(L.parseSalary("1000001").error).toBeTruthy();
    expect(L.parseSalary("abc").error).toBeTruthy();
  });
  test("buildAnswers shapes the backend payload and collects errors", () => {
    const ok = L.buildAnswers({ salary: "60000", city: " Guadalajara ", remote: "hybrid", languages: [{ language: "Alemán", level: "B2" }] });
    expect(ok.errors).toEqual([]);
    expect(ok.answers).toEqual({ salary_floor_mxn: 60000, city: "Guadalajara", remote: "hybrid", languages: ["Alemán B2"] });
    const empty = L.buildAnswers({ salary: "", city: "", remote: "", languages: [] });
    expect(empty.answers).toEqual({ salary_floor_mxn: null, city: null, remote: null, languages: [] });
    const bad = L.buildAnswers({ salary: "mucho", city: "x".repeat(81), remote: "", languages: [] });
    expect(bad.errors.map((e: any) => e.field).sort()).toEqual(["city", "salary"]);
    const many = L.buildAnswers({ salary: "", city: "", remote: "", languages: Array.from({ length: 11 }, (_, i) => ({ language: `L${i}`, level: "A1" })) });
    expect(many.errors[0].field).toBe("languages");
  });
});

describe("proposal <-> form draft", () => {
  test("round trip leaves a valid proposal untouched", () => {
    expect(L.fromDraft(L.toDraft(PROPOSAL))).toEqual(PROPOSAL);
  });
  test("toDraft does not mutate and stringifies list fields", () => {
    const before = JSON.stringify(PROPOSAL);
    const d = L.toDraft(PROPOSAL);
    expect(JSON.stringify(PROPOSAL)).toBe(before);
    expect(d.stack.strong).toBe("python, postgresql, django");
    expect(d.targets.roles).toBe("Backend Developer\nData Engineer");
    expect(d.experience[0].highlights).toEqual(["Built ETL pipelines in Python and PostgreSQL.", "Reduced nightly job time from 6h to 2h."]);
    expect(d.years_experience.value).toBe("5.5");
  });
  test("fromDraft: blanks become null, numbers parse, lists split, lang lowercased", () => {
    const d = L.toDraft(PROPOSAL);
    d.identity.phone = "  ";
    d.identity.links = "https://a.example\n https://b.example ";
    d.years_experience.value = "";
    d.targets.salary_floor_mxn = "75,000";
    d.targets.roles = "Dev, QA\n";
    d.stack.avoid = "";
    d.languages[1].write = "";
    d.search_families[0].queries[0].lang = " EN ";
    d.experience[0].highlights = ["uno", "  ", "dos"];
    const p = L.fromDraft(d);
    expect(p.identity.phone).toBeNull();
    expect(p.identity.links).toEqual(["https://a.example", "https://b.example"]);
    expect(p.years_experience.value).toBeNull();
    expect(p.targets.salary_floor_mxn).toBe(75000);
    expect(p.targets.roles).toEqual(["Dev", "QA"]);
    expect(p.stack.avoid).toEqual([]);
    expect(p.languages[1].write).toBeNull();
    expect(p.search_families[0].queries[0].lang).toBe("en");
    expect(p.experience[0].highlights).toEqual(["uno", "dos"]);
  });
  test("fromDraft keeps unparseable numbers as text so the server reports them", () => {
    const d = L.toDraft(PROPOSAL);
    d.years_experience.value = "mucho";
    d.targets.salary_floor_mxn = "poco";
    const p = L.fromDraft(d);
    expect(p.years_experience.value).toBe("mucho");
    expect(p.targets.salary_floor_mxn).toBe("poco");
  });
  test("row factories and list helpers", () => {
    expect(L.newRow("skill")).toEqual({ name: "", level: "", evidence: "", inferred: false });
    expect(L.newRow("language")).toEqual({ language: "", read: "", write: "", speak: "", inferred: false });
    expect(L.newRow("query")).toEqual({ text: "", lang: "es" });
    expect(L.newRow("family").queries).toEqual([{ text: "", lang: "es" }]);
    const d = { a: [1, 2, 3] };
    L.removeAt(d, "a", 1);
    expect(d.a).toEqual([1, 3]);
    expect(() => L.removeAt(d, "a", 9)).not.toThrow();
  });
  test("setPath/getPath use dotted paths with indexes", () => {
    const d = L.toDraft(PROPOSAL);
    L.setPath(d, "skills.2.evidence", "nuevo");
    expect(L.getPath(d, "skills.2.evidence")).toBe("nuevo");
    expect(L.getPath(d, "skills.9.evidence")).toBeUndefined();
  });
});

describe("server errors", () => {
  const details = [
    { path: "targets.salary_floor_mxn", message: "mal sueldo" },
    { path: "experience[1].company", message: "falta" },
    { path: "identity.links[2]", message: "URL" },
    { path: "", message: "global" },
  ];
  test("normPath turns brackets into dots", () => {
    expect(L.normPath("experience[1].company")).toBe("experience.1.company");
  });
  test("errorsFor matches exact fields and children", () => {
    expect(L.errorsFor(details, "experience.1.company").map((e: any) => e.message)).toEqual(["falta"]);
    expect(L.errorsFor(details, "identity.links").map((e: any) => e.message)).toEqual(["URL"]);
    expect(L.errorsFor(details, "experience.1").length).toBe(1);
    expect(L.errorsFor(details, "experience.10").length).toBe(0);
    expect(L.errorsFor(null, "x")).toEqual([]);
  });
  test("pathLabel is human Spanish", () => {
    expect(L.pathLabel("experience[1].company")).toBe("Experiencia 2 · empresa");
    expect(L.pathLabel("targets.salary_floor_mxn")).toBe("Objetivos · sueldo mínimo");
    expect(L.pathLabel("")).toBe("Propuesta");
    expect(L.pathLabel("search_families[0].queries[2].lang")).toBe("Familia de búsqueda 1 · consulta 3 · idioma");
  });
  test("describeApiError prefers the server message and explains private_repo", () => {
    expect(L.describeApiError({ status: 400, data: { error: "empty", message: "Falta algo." } })).toBe("Falta algo.");
    expect(L.describeApiError({ status: 409, data: { error: "private_repo", message: "x" } })).toMatch(/repositorio privado/);
    expect(L.describeApiError({ status: 413, data: {} })).toMatch(/demasiado grande/);
    expect(L.describeApiError(new TypeError("Failed to fetch"))).toMatch(/conexión/);
  });
});

describe("confirm gating and warnings", () => {
  test("canConfirm needs a proposal, no flagged fields and no pending work", () => {
    expect(L.canConfirm({ flagged: [], busy: false })).toBe(true);
    expect(L.canConfirm({ flagged: ["summary"], busy: false })).toBe(false);
    expect(L.canConfirm({ flagged: [], busy: true })).toBe(false);
  });
  test("warnings: the automatic ⚠ ones are emphasised", () => {
    expect(L.isFlaggedWarning("⚠ Campo «summary» parece contener instrucciones")).toBe(true);
    expect(L.isFlaggedWarning("El CV no menciona fechas")).toBe(false);
  });
  test("questions: only the salary one has a target field", () => {
    expect(L.questionTarget({ id: "current_salary" })).toBe("current_salary");
    expect(L.questionTarget({ id: "current_salary_mxn" })).toBe("current_salary");
    expect(L.questionTarget({ id: "city" })).toBeNull();
  });
  test("flaggedLabels names the fields to edit", () => {
    expect(L.flaggedLabels(["summary", "skills[0].evidence"])).toEqual(["Resumen", "Habilidad 1 · evidencia"]);
  });
});

describe("run progress folding", () => {
  test("keeps the log, latest step, cost and last error", () => {
    let s = L.newProgress();
    s = L.foldEvent(s, { type: "step", text: "Extrayendo texto" });
    s = L.foldEvent(s, { type: "tool", text: "Read: x" });
    s = L.foldEvent(s, { type: "cost", text: "Costo de esta corrida: ~$0.30" });
    s = L.foldEvent(s, { type: "error", text: "Falló algo" });
    expect(s.latest).toBe("Falló algo");
    expect(s.step).toBe("Extrayendo texto");
    expect(s.cost).toBe("Costo de esta corrida: ~$0.30");
    expect(s.lastError).toBe("Falló algo");
    expect(s.lines.length).toBe(4);
  });
  test("log is capped", () => {
    let s = L.newProgress();
    for (let i = 0; i < 500; i++) s = L.foldEvent(s, { type: "tool", text: `t${i}` });
    expect(s.lines.length).toBe(200);
    expect(s.lines.at(-1).text).toBe("t499");
  });
});

describe("misc", () => {
  test("formatBytes", () => {
    expect(L.formatBytes(500)).toBe("500 B");
    expect(L.formatBytes(2048)).toBe("2.0 KB");
    expect(L.formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
  test("parseCurrentSalary is optional and bounded", () => {
    expect(L.parseCurrentSalary("")).toEqual({ value: null });
    expect(L.parseCurrentSalary("52,000")).toEqual({ value: 52000 });
    expect(L.parseCurrentSalary("-3").error).toBeTruthy();
  });
});
