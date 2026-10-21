// Pure helpers for the first-run screens (no DOM, no fetch): unit-tested from ui/tests/onboarding_ui.test.ts.

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_TEXT = 20000;
export const MAX_LANGUAGES = 10;
export const ALLOWED_EXT = [".pdf", ".docx", ".txt", ".md"];
export const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2", "native"];
export const levelLabel = (l) => (l === "native" ? "Nativo" : l);

const WORD_OF_LEVEL = (l) => (l === "native" ? "nativo" : l);

// ---------- entry screen ----------
export function validateEntry({ fileName, fileSize, text }) {
  const t = (text || "").trim();
  if (fileName) {
    const ext = (fileName.match(/\.[^./\\]+$/) || [""])[0].toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) return { ok: false, error: "Formato no admitido. Usa PDF, DOCX, TXT o MD." };
    if (fileSize === 0) return { ok: false, error: "El archivo está vacío." };
    if (fileSize > MAX_FILE_BYTES) return { ok: false, error: "El archivo pesa más de 2 MB. Usa una versión más ligera." };
  }
  if ((text || "").length > MAX_TEXT) return { ok: false, error: "El texto es demasiado largo (máximo 20,000 caracteres)." };
  if (!fileName && !t) return { ok: false, error: "Sube tu CV o cuéntame algo sobre ti para poder empezar." };
  return { ok: true };
}

const intFrom = (raw, min, max) => {
  const s = String(raw ?? "").replace(/[$,\s]/g, "");
  if (s === "") return { value: null };
  if (!/^\d+$/.test(s)) return { value: null, error: "Escribe solo un número entero, sin decimales." };
  const n = Number(s);
  if (n < min || n > max) return { value: null, error: `Debe estar entre ${min.toLocaleString("en-US")} y ${max.toLocaleString("en-US")}.` };
  return { value: n };
};
export const parseSalary = (raw) => intFrom(raw, 1, 1_000_000);
export const parseCurrentSalary = (raw) => intFrom(raw, 1, 1_000_000);

export function languagesToAnswers(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    const name = (r.language || "").trim().replace(/\s+/g, " ");
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r.level ? `${name} ${WORD_OF_LEVEL(r.level)}` : name);
  }
  return out;
}

export function buildAnswers({ salary, city, remote, languages }) {
  const errors = [];
  const s = parseSalary(salary);
  if (s.error) errors.push({ field: "salary", message: s.error });
  const c = (city || "").trim().replace(/\s+/g, " ");
  if (c.length > 80) errors.push({ field: "city", message: "La ciudad debe ser un texto corto (máximo 80 caracteres)." });
  const langs = languagesToAnswers(languages);
  if (langs.length > MAX_LANGUAGES) errors.push({ field: "languages", message: `Máximo ${MAX_LANGUAGES} idiomas.` });
  return {
    answers: { salary_floor_mxn: s.value, city: c || null, remote: remote || null, languages: langs },
    errors,
  };
}

// ---------- proposal <-> editable draft ----------
const clone = (v) => JSON.parse(JSON.stringify(v));
const splitBy = (text, re) => String(text ?? "").split(re).map((s) => s.trim()).filter(Boolean);
export const splitCommaLines = (t) => splitBy(t, /[\n,]+/);
export const splitLines = (t) => splitBy(t, /[\n\s]+/);
const blank = (s) => {
  const t = typeof s === "string" ? s.trim() : s;
  return t === "" || t === undefined ? null : t;
};
const numOrText = (s) => {
  const t = String(s ?? "").trim().replace(/,/g, "");
  if (t === "") return null;
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : String(s).trim();
};
const toStr = (v) => (v === null || v === undefined ? "" : String(v));

/** Proposal -> draft: every field the user types into is a string; list-of-strings become text. */
export function toDraft(p) {
  const d = clone(p);
  d.identity.links = (d.identity.links || []).join("\n");
  d.identity = { ...d.identity, name: toStr(d.identity.name), email: toStr(d.identity.email), phone: toStr(d.identity.phone), location: toStr(d.identity.location) };
  d.summary = toStr(d.summary);
  d.years_experience = { value: toStr(d.years_experience?.value), basis: toStr(d.years_experience?.basis) };
  d.experience = (d.experience || []).map((e) => ({
    company: toStr(e.company), title: toStr(e.title), start: toStr(e.start), end: toStr(e.end), highlights: [...(e.highlights || [])],
  }));
  d.education = (d.education || []).map((e) => ({
    degree: toStr(e.degree), institution: toStr(e.institution), status: toStr(e.status), start: toStr(e.start), end: toStr(e.end),
  }));
  d.skills = (d.skills || []).map((s) => ({ name: toStr(s.name), level: toStr(s.level), evidence: toStr(s.evidence), inferred: !!s.inferred }));
  d.languages = (d.languages || []).map((l) => ({
    language: toStr(l.language), read: toStr(l.read), write: toStr(l.write), speak: toStr(l.speak), inferred: !!l.inferred,
  }));
  d.targets = {
    roles: (d.targets?.roles || []).join("\n"),
    remote: toStr(d.targets?.remote),
    location: toStr(d.targets?.location),
    salary_floor_mxn: toStr(d.targets?.salary_floor_mxn),
  };
  d.search_families = (d.search_families || []).map((f) => ({
    name: toStr(f.name), inferred: !!f.inferred, queries: (f.queries || []).map((q) => ({ text: toStr(q.text), lang: toStr(q.lang) })),
  }));
  d.stack = {
    strong: (d.stack?.strong || []).join(", "),
    secondary: (d.stack?.secondary || []).join(", "),
    avoid: (d.stack?.avoid || []).join(", "),
  };
  return d;
}

/** Draft -> proposal ready for PUT. Blank nullable text becomes null; the server stays the judge of validity. */
export function fromDraft(d) {
  const p = clone(d);
  p.identity = {
    name: blank(d.identity.name), email: blank(d.identity.email), phone: blank(d.identity.phone),
    location: blank(d.identity.location), links: splitLines(d.identity.links),
  };
  p.summary = String(d.summary ?? "").trim();
  p.years_experience = { value: numOrText(d.years_experience.value), basis: blank(d.years_experience.basis) };
  p.experience = d.experience.map((e) => ({
    company: blank(e.company), title: blank(e.title), start: blank(e.start), end: blank(e.end),
    highlights: (e.highlights || []).map((h) => String(h).trim()).filter(Boolean),
  }));
  p.education = d.education.map((e) => ({
    degree: blank(e.degree), institution: blank(e.institution), status: blank(e.status), start: blank(e.start), end: blank(e.end),
  }));
  p.skills = d.skills.map((s) => ({ name: blank(s.name), level: blank(s.level), evidence: blank(s.evidence), inferred: !!s.inferred }));
  p.languages = d.languages.map((l) => ({
    language: blank(l.language), read: blank(l.read), write: blank(l.write), speak: blank(l.speak), inferred: !!l.inferred,
  }));
  p.targets = {
    roles: splitCommaLines(d.targets.roles),
    remote: blank(d.targets.remote),
    location: blank(d.targets.location),
    salary_floor_mxn: numOrText(d.targets.salary_floor_mxn),
  };
  p.search_families = d.search_families.map((f) => ({
    name: blank(f.name), inferred: !!f.inferred,
    queries: f.queries.map((q) => ({ text: blank(q.text), lang: String(q.lang ?? "").trim().toLowerCase() })),
  }));
  p.stack = { strong: splitCommaLines(d.stack.strong), secondary: splitCommaLines(d.stack.secondary), avoid: splitCommaLines(d.stack.avoid) };
  return p;
}

export function newRow(kind) {
  switch (kind) {
    case "experience": return { company: "", title: "", start: "", end: "", highlights: [] };
    case "education": return { degree: "", institution: "", status: "", start: "", end: "" };
    case "skill": return { name: "", level: "", evidence: "", inferred: false };
    case "language": return { language: "", read: "", write: "", speak: "", inferred: false };
    case "query": return { text: "", lang: "es" };
    case "family": return { name: "", queries: [newRow("query")], inferred: false };
    default: throw new Error(`unknown row kind ${kind}`);
  }
}

const walk = (obj, path) => String(path).split(".").filter(Boolean).reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj);
export const getPath = (obj, path) => walk(obj, path);
export function setPath(obj, path, value) {
  const keys = String(path).split(".").filter(Boolean);
  const last = keys.pop();
  const parent = keys.length ? walk(obj, keys.join(".")) : obj;
  if (parent === undefined || parent === null) return false;
  parent[last] = value;
  return true;
}
export function removeAt(obj, path, index) {
  const list = walk(obj, path);
  if (Array.isArray(list) && index >= 0 && index < list.length) list.splice(index, 1);
}

// ---------- server errors ----------
export const normPath = (p) => String(p || "").replace(/\[(\d+)\]/g, ".$1");

export function errorsFor(details, path) {
  if (!Array.isArray(details)) return [];
  const want = normPath(path);
  return details.filter((e) => {
    const got = normPath(e.path);
    return got === want || got.startsWith(want + ".");
  });
}

const SECTION = {
  identity: "Identidad", summary: "Resumen", years_experience: "Años de experiencia", experience: "Experiencia", education: "Educación",
  skills: "Habilidades", languages: "Idiomas", targets: "Objetivos", search_families: "Familias de búsqueda", stack: "Stack",
  questions: "Preguntas", warnings: "Avisos", version: "Versión",
};
const SECTION_ROW = { experience: "Experiencia", education: "Educación", skills: "Habilidad", languages: "Idioma", search_families: "Familia de búsqueda" };
const FIELD = {
  name: "nombre", email: "correo", phone: "teléfono", location: "ubicación", links: "enlaces", value: "valor", basis: "cómo se calculó",
  company: "empresa", title: "puesto", start: "inicio", end: "fin", highlights: "logros", degree: "título", institution: "institución",
  status: "estado", level: "nivel", evidence: "evidencia", inferred: "deducido", language: "idioma", read: "lectura", write: "escritura",
  speak: "conversación", roles: "puestos", remote: "modalidad", salary_floor_mxn: "sueldo mínimo", queries: "consultas", text: "texto",
  lang: "idioma", strong: "fuerte", secondary: "secundario", avoid: "evitar",
};

export function pathLabel(path) {
  const parts = normPath(path).split(".").filter(Boolean);
  if (!parts.length) return "Propuesta";
  const [head, ...rest] = parts;
  const out = [];
  let i = 0;
  if (SECTION_ROW[head] && rest[0] !== undefined && /^\d+$/.test(rest[0])) {
    out.push(`${SECTION_ROW[head]} ${Number(rest[0]) + 1}`);
    i = 1;
  } else {
    out.push(SECTION[head] || head);
  }
  for (; i < rest.length; i++) {
    const k = rest[i];
    if (/^\d+$/.test(k)) continue;
    const next = rest[i + 1];
    if (k === "queries" && next !== undefined && /^\d+$/.test(next)) {
      out.push(`consulta ${Number(next) + 1}`);
      i++;
    } else out.push(FIELD[k] || k);
  }
  return out.join(" · ");
}

export const flaggedLabels = (paths) => (paths || []).map(pathLabel);

export function describeApiError(err) {
  const status = err && err.status;
  const data = (err && err.data) || {};
  if (data.error === "private_repo") {
    return "Este es un repositorio privado con tu perfil real: por seguridad no lo sobrescribo. La configuración guiada solo funciona en una copia limpia.";
  }
  if (typeof data.message === "string" && data.message) return data.message;
  if (status === 413) return "Lo que enviaste es demasiado grande.";
  if (status === 409) return "Hay otra tarea en curso; espera a que termine.";
  if (status) return "Algo salió mal en tu computadora. Intenta de nuevo.";
  return "No pude conectarme con el panel. Revisa tu conexión local e intenta de nuevo.";
}

// ---------- review gating ----------
export const canConfirm = ({ flagged, busy }) => !busy && (!flagged || flagged.length === 0);
export const isFlaggedWarning = (w) => String(w).trim().startsWith("⚠");
export const questionTarget = (q) => (q && (q.id === "current_salary" || q.id === "current_salary_mxn") ? "current_salary" : null);

// ---------- run progress ----------
const LOG_CAP = 200;
export const newProgress = () => ({ lines: [], step: "", latest: "", cost: "", lastError: "" });
export function foldEvent(state, e) {
  const s = { ...state, lines: state.lines.concat([{ type: e.type, text: e.text }]).slice(-LOG_CAP) };
  if (e.type === "step") s.step = e.text;
  if (e.type === "cost") s.cost = e.text;
  else s.latest = e.text;
  if (e.type === "error") s.lastError = e.text;
  return s;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
