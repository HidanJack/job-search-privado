import { describe, expect, test } from "bun:test";

// Pure helpers behind the "Descubrir" tab (public/discovery-logic.js).
const L: any = await import("../public/discovery-logic.js");

const MARKET = (over: Record<string, unknown> = {}) => ({
  vacancies: 4, raw_results: 31, by_portal: { himalayas: 4 }, samples: [], as_of: "2026-10-21", window_days: 30, calls: 15, failures: 0,
  no_demand_seen: false, unreachable: false, ...over,
});

describe("confidenceView", () => {
  test("labels and mutes low confidence as exploration", () => {
    expect(L.confidenceView("high")).toEqual({ label: "Confianza alta", muted: false, exploration: false });
    expect(L.confidenceView("medium")).toEqual({ label: "Confianza media", muted: false, exploration: false });
    expect(L.confidenceView("low")).toEqual({ label: "Confianza baja", muted: true, exploration: true });
  });
  test("unknown values are treated as low", () => {
    expect(L.confidenceView("???").muted).toBe(true);
    expect(L.confidenceView(undefined).exploration).toBe(true);
  });
});

describe("marketView", () => {
  test("null market is not queried", () => {
    expect(L.marketView(null)).toMatchObject({ kind: "none", text: "Mercado sin consultar", note: null, samples: [] });
  });
  test("unreachable", () => {
    expect(L.marketView(MARKET({ unreachable: true, vacancies: 0 }))).toMatchObject({ kind: "unreachable", text: "No se pudo consultar el mercado", note: null });
  });
  test("no demand seen carries the honest note and the window", () => {
    const v = L.marketView(MARKET({ no_demand_seen: true, vacancies: 0 }));
    expect(v.kind).toBe("no_demand");
    expect(v.text).toBe("Sin demanda visible en estos portales (últimos 30 días)");
    expect(v.note).toBe("Estos portales son tableros remotos pequeños: no incluyen Indeed ni LinkedIn. Cero aquí no significa que no haya mercado.");
  });
  test("demand text pluralises and shows relevant out of raw", () => {
    expect(L.marketView(MARKET()).text).toBe("4 vacantes relevantes de 31 que devolvieron los portales (últimos 30 días)");
    expect(L.marketView(MARKET({ vacancies: 1, raw_results: 1 })).text).toBe("1 vacante relevante de 1 que devolvieron los portales (últimos 30 días)");
    expect(L.marketView(MARKET({ vacancies: 3, raw_results: 7, window_days: 45 })).text).toContain("(últimos 45 días)");
  });
  test("a missing window (older market.json) drops the parenthesis; 1 day is singular", () => {
    expect(L.marketView(MARKET({ window_days: undefined })).text).toBe("4 vacantes relevantes de 31 que devolvieron los portales");
    expect(L.marketView(MARKET({ window_days: 1, no_demand_seen: true, vacancies: 0 })).text).toBe("Sin demanda visible en estos portales (último día)");
  });
  test("samples keep only safe http(s) links, at most 5, with a readable portal", () => {
    const s = [
      { title: "A", company: "X", portal: "himalayas", url: "https://a.example/1" },
      { title: "B", company: "Y", portal: "getonbrd-search", url: "javascript:alert(1)" },
      { title: "C", company: "Z", portal: "remoteok", url: "http://c.example/3" },
    ];
    const v = L.marketView(MARKET({ samples: s }));
    expect(v.samples.map((x: any) => x.title)).toEqual(["A", "C"]);
    expect(v.samples[0].portal).toBe("Himalayas");
  });
});

describe("pluralisation helpers", () => {
  test("windowPhrase", () => {
    expect(L.windowPhrase(30)).toBe("últimos 30 días");
    expect(L.windowPhrase(1)).toBe("último día");
    expect(L.windowPhrase(undefined)).toBe("");
    expect(L.windowPhrase(0)).toBe("");
  });
});

describe("splitPaths", () => {
  const paths = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  test("keeps the returned order; added wins over dismissed; dismissed are separated", () => {
    const r = L.splitPaths({ paths, dismissed: ["b", "c"], added: ["c", "x"] });
    expect(r.open.map((p: any) => p.id)).toEqual(["a", "c", "d"]);
    expect(r.added).toEqual(["c"]);
    expect(r.dismissed.map((p: any) => p.id)).toEqual(["b"]);
  });
  test("tolerates missing lists", () => {
    const r = L.splitPaths({ paths });
    expect(r.open.length).toBe(4);
    expect(r.dismissed).toEqual([]);
  });
});

describe("queries", () => {
  const q = [{ text: "document ai engineer", lang: "en" }, { text: "ingeniero de ia documental", lang: "es" }];
  test("all checked by default and a stable key", () => {
    expect(L.queryKey(q[1])).toBe("es|ingeniero de ia documental");
    expect([...L.allChecked(q)]).toEqual(["en|document ai engineer", "es|ingeniero de ia documental"]);
  });
  test("buildAddBody sends only the checked queries, in order; null when none", () => {
    expect(L.buildAddBody("p1", q, new Set(["es|ingeniero de ia documental"]))).toEqual({ id: "p1", queries: [{ text: "ingeniero de ia documental", lang: "es" }] });
    expect(L.buildAddBody("p1", q, new Set(L.allChecked(q))).queries.length).toBe(2);
    expect(L.buildAddBody("p1", q, new Set())).toBeNull();
  });
  test("langLabel", () => {
    expect(L.langLabel("en")).toBe("EN");
    expect(L.langLabel("")).toBe("");
  });
});

describe("describeAdd", () => {
  test("reports added queries, duplicates and the backup", () => {
    const m = L.describeAdd({ ok: true, family: { name: "Descubierto: X" }, added_queries: 2, duplicates: 1, backup: "profile_config.json.bak-1" });
    expect(m.title).toBe("Agregado a tus búsquedas: Descubierto: X");
    expect(m.lines).toEqual(["Se agregaron 2 consultas.", "1 consulta ya existía y se omitió.", "Copia de seguridad: profile_config.json.bak-1"]);
  });
  test("singular and no duplicates, no backup", () => {
    const m = L.describeAdd({ ok: true, family: { name: "F" }, added_queries: 1, duplicates: 0 });
    expect(m.lines).toEqual(["Se agregó 1 consulta."]);
  });
});

describe("describeError", () => {
  test("maps backend codes to clear Spanish", () => {
    expect(L.describeError({ status: 409, data: { error: "already_added" } })).toBe("Este camino ya está en tus búsquedas.");
    expect(L.describeError({ status: 422, data: { error: "no_new_queries" } })).toContain("ya están en tus búsquedas");
    expect(L.describeError({ status: 409, data: { error: "busy" } })).toBe("Hay otra tarea en curso; espera a que termine e inténtalo de nuevo.");
    expect(L.describeError({ status: 409, data: { error: "config_missing" } })).toContain("profile_config.json");
    expect(L.describeError({ status: 409, data: { error: "config_invalid" } })).toContain("profile_config.json");
    expect(L.describeError({ status: 404, data: { error: "path_not_found" } })).toContain("Actualiza");
  });
  test("falls back to the server message, then to status/connection text", () => {
    expect(L.describeError({ status: 500, data: { error: "x", message: "Algo específico." } })).toBe("Algo específico.");
    expect(L.describeError({ status: 500, data: {} })).toBe("Algo salió mal en tu computadora. Intenta de nuevo.");
    expect(L.describeError(new Error("fail"))).toBe("No pude conectarme con el panel. Revisa tu conexión local e intenta de nuevo.");
  });
});

describe("viewMode", () => {
  test("a running run wins, then proposals, then empty", () => {
    expect(L.viewMode({ has_proposals: true, run: { status: "running" }, probing: false })).toBe("running");
    expect(L.viewMode({ has_proposals: true, run: null, probing: true })).toBe("running");
    expect(L.viewMode({ has_proposals: true, run: { status: "done" }, probing: false })).toBe("proposals");
    expect(L.viewMode({ has_proposals: false, run: null, probing: false })).toBe("empty");
    expect(L.viewMode({ has_proposals: false, run: { status: "failed" }, probing: false })).toBe("empty");
  });
});

describe("notices", () => {
  test("validation errors become a Spanish list, capped", () => {
    const errs = Array.from({ length: 7 }, (_, i) => ({ path: "", message: `Error ${i}.` }));
    const n = L.validationNotice(errs);
    expect(n.title).toBe("La última propuesta no era válida");
    expect(n.items.length).toBe(5);
    expect(n.more).toBe(2);
    expect(L.validationNotice(null)).toBeNull();
    expect(L.validationNotice([])).toBeNull();
  });
});

describe("formatGenerated", () => {
  test("long Spanish date from YYYY-MM-DD, empty for junk", () => {
    expect(L.formatGenerated("2026-10-21")).toBe("21 de octubre de 2026");
    expect(L.formatGenerated("2026-01-05")).toBe("5 de enero de 2026");
    expect(L.formatGenerated("nope")).toBe("");
    expect(L.formatGenerated(null)).toBe("");
  });
});

describe("progress", () => {
  test("foldEvent tracks step, cost and last error", () => {
    let s = L.newProgress();
    s = L.foldEvent(s, { type: "step", text: "Preparando tu perfil (sin IA)" });
    s = L.foldEvent(s, { type: "text", text: "hola" });
    s = L.foldEvent(s, { type: "cost", text: "Costo: US$0.12" });
    s = L.foldEvent(s, { type: "error", text: "falló" });
    expect(s).toMatchObject({ step: "Preparando tu perfil (sin IA)", cost: "Costo: US$0.12", lastError: "falló" });
    expect(s.lines.length).toBe(4);
  });
});
