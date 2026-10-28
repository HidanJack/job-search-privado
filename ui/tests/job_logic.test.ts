import { describe, expect, test } from "bun:test";

// Pure helpers behind the Vacantes cards and the "Lista negra" panel (public/job-logic.js).
const L: any = await import("../public/job-logic.js");

const job = (over: Record<string, unknown> = {}) => ({
  posting_language: "en", language_need: null, language_evidence: null, language_note: null, spoken_language: null, ...over,
});

describe("languageChips", () => {
  test("an explicit spoken requirement is a warning chip with the quote as tooltip", () => {
    const [chip] = L.languageChips(job({ language_need: "spoken", spoken_language: "en", language_evidence: "Fluent English", language_note: "Piden inglés fluido." }));
    expect(chip).toEqual({ text: "Inglés hablado", cls: "chip warn", title: "Piden inglés fluido." });
  });
  test("unspecified level names the posting language", () => {
    const [chip] = L.languageChips(job({ language_need: "unspecified", language_note: "No especifica el nivel; probablemente hay reuniones en inglés." }));
    expect(chip.text).toBe("Nivel de inglés no especificado");
    expect(chip.cls).toBe("chip");
    expect(L.languageChips(job({ posting_language: "de", language_need: "unspecified" }))[0].text).toBe("Nivel de alemán no especificado");
  });
  test("read/write only", () => {
    const [chip] = L.languageChips(job({ language_need: "read_write", language_evidence: "read and write technical English" }));
    expect(chip.text).toBe("Solo lectura/escritura");
    expect(chip.title).toContain("read and write technical English");
  });
  test("nothing for plus, none, or spanish postings; legacy spoken chip keeps working", () => {
    expect(L.languageChips(job({ language_need: "optional" }))).toEqual([]);
    expect(L.languageChips(job({ posting_language: "es", language_need: "none" }))).toEqual([]);
    expect(L.languageChips(job({ language_need: "spoken", spoken_language: "de" }))[0].text).toBe("Alemán hablado");
  });
});

describe("languageQuote", () => {
  test("verbatim evidence only, shortened for display", () => {
    expect(L.languageQuote(job({ language_evidence: "Fluent English" }))).toBe("«Fluent English»");
    expect(L.languageQuote(job())).toBeNull();
    expect(L.languageQuote(job({ language_evidence: "x".repeat(300) })).length).toBeLessThanOrEqual(163);
  });
});

describe("blocklist views", () => {
  test("entry line", () => {
    expect(L.entryView({ name: "Acme Spam", aliases: ["Acme"], reason: "basura", added: "2026-10-28" }, 3)).toEqual({
      title: "Acme Spam", detail: "Alias: Acme · basura · 3 vacantes", 
    });
    expect(L.entryView({ name: "X", aliases: [], added: null }, 1).detail).toBe("1 vacante");
    expect(L.entryView({ name: "X", aliases: [], added: null }, 0).detail).toBe("Sin vacantes guardadas");
  });
  test("suggestion line explains why and never blocks by itself", () => {
    expect(L.suggestionView({ company: "Stale Inc", count: 9, medianAgeDays: 61, reposted: 0, why: "vacantes muy viejas" }))
      .toBe("Stale Inc · 9 vacantes · mediana de 61 días · vacantes muy viejas");
    expect(L.suggestionView({ company: "R", count: 10, medianAgeDays: null, reposted: 6, why: "vacantes republicadas" }))
      .toBe("R · 10 vacantes · 6 republicadas · vacantes republicadas");
  });
  test("confirmation text names the company", () => {
    expect(L.confirmBlockText("Acme Spam")).toContain("Acme Spam");
  });
  test("API errors are shown in Spanish", () => {
    expect(L.blockErrorText({ message: "Escribe el nombre de la empresa." })).toBe("Escribe el nombre de la empresa.");
    expect(L.blockErrorText({})).toBe("No se pudo actualizar la lista negra.");
  });
});
