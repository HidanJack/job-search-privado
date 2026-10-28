// Pure helpers for the "Descubrir" tab (no DOM, no fetch): unit-tested from ui/tests/discovery_ui.test.ts.
// Everything that comes from the model or the portals is untrusted: callers only ever set it through textContent.

export const MAX_SAMPLES_SHOWN = 5;
export const MAX_VALIDATION_SHOWN = 5;

const PORTAL_LABEL = {
  getonbrd: "GetOnBoard", himalayas: "Himalayas", remoteok: "Remote OK", jobicy: "Jobicy", "hn-hiring": "Hacker News",
};
export function portalLabel(p) {
  const base = String(p || "").trim().replace(/-search$/i, "");
  return PORTAL_LABEL[base.toLowerCase()] || (base ? base.charAt(0).toUpperCase() + base.slice(1) : "");
}

// ---------- confidence ----------
const CONFIDENCE = { high: "Confianza alta", medium: "Confianza media", low: "Confianza baja" };
export function confidenceView(c) {
  const key = c === "high" || c === "medium" ? c : "low";
  return { label: CONFIDENCE[key], muted: key === "low", exploration: key === "low" };
}

// ---------- market ----------
export function windowPhrase(days) {
  if (!Number.isInteger(days) || days < 1) return "";
  return days === 1 ? "último día" : `últimos ${days} días`;
}
const isHttp = (u) => typeof u === "string" && /^https?:\/\//i.test(u);
export const NO_DEMAND_NOTE =
  "Estos portales son tableros remotos pequeños: no incluyen Indeed ni LinkedIn. Cero aquí no significa que no haya mercado.";

export function marketView(m) {
  if (!m) return { kind: "none", text: "Mercado sin consultar", note: null, samples: [], by_portal: [] };
  if (m.unreachable) return { kind: "unreachable", text: "No se pudo consultar el mercado", note: null, samples: [], by_portal: [] };
  const win = windowPhrase(m.window_days);
  const paren = win ? ` (${win})` : "";
  const samples = (Array.isArray(m.samples) ? m.samples : [])
    .filter((s) => s && isHttp(s.url))
    .slice(0, MAX_SAMPLES_SHOWN)
    .map((s) => ({ title: String(s.title || ""), company: String(s.company || ""), portal: portalLabel(s.portal), url: s.url }));
  if (m.no_demand_seen) return { kind: "no_demand", text: `Sin demanda visible en estos portales${paren}`, note: NO_DEMAND_NOTE, samples, by_portal: [] };
  const n = m.vacancies | 0;
  const by_portal = Object.entries(m.by_portal || {}).map(([p, c]) => ({ portal: portalLabel(p), count: c }));
  return {
    kind: "demand",
    text: `${n} ${n === 1 ? "vacante relevante" : "vacantes relevantes"} de ${m.raw_results | 0} que devolvieron los portales${paren}`,
    note: null, samples, by_portal,
  };
}

// ---------- lists ----------
export function splitPaths({ paths, dismissed, added }) {
  const ids = new Set((paths || []).map((p) => p.id));
  const addedIds = (added || []).filter((id) => ids.has(id));
  const addedSet = new Set(addedIds);
  const dismissedSet = new Set((dismissed || []).filter((id) => !addedSet.has(id)));
  return {
    open: (paths || []).filter((p) => !dismissedSet.has(p.id)),
    added: addedIds,
    dismissed: (paths || []).filter((p) => dismissedSet.has(p.id)),
  };
}

// ---------- queries ----------
export const queryKey = (q) => `${q.lang}|${q.text}`;
export const allChecked = (queries) => new Set((queries || []).map(queryKey));
export const langLabel = (lang) => String(lang || "").toUpperCase();
export function buildAddBody(id, queries, checked) {
  const picked = (queries || []).filter((q) => checked.has(queryKey(q))).map((q) => ({ text: q.text, lang: q.lang }));
  return picked.length ? { id, queries: picked } : null;
}

// ---------- messages ----------
export function describeAdd(r) {
  const lines = [];
  const added = r.added_queries | 0;
  lines.push(added === 1 ? "Se agregó 1 consulta." : `Se agregaron ${added} consultas.`);
  const dup = r.duplicates | 0;
  if (dup > 0) lines.push(dup === 1 ? "1 consulta ya existía y se omitió." : `${dup} consultas ya existían y se omitieron.`);
  if (r.backup) lines.push(`Copia de seguridad: ${r.backup}`);
  return { title: `Agregado a tus búsquedas: ${(r.family && r.family.name) || "camino nuevo"}`, lines };
}

const ERRORS = {
  already_added: "Este camino ya está en tus búsquedas.",
  no_new_queries: "Todas las consultas elegidas ya están en tus búsquedas; no hay nada nuevo que agregar.",
  busy: "Hay otra tarea en curso; espera a que termine e inténtalo de nuevo.",
  config_missing: "Falta profile_config.json: termina la configuración inicial antes de agregar búsquedas.",
  config_invalid: "Tu profile_config.json no es válido; corrígelo antes de agregar búsquedas.",
  path_not_found: "Ese camino ya no está en las propuestas. Actualiza la lista con «Descubrir caminos».",
  no_proposals: "Todavía no hay propuestas. Ejecuta primero el descubrimiento.",
  bad_queries: "Elige al menos una consulta válida para agregar.",
};
export function describeError(err) {
  const data = (err && err.data) || {};
  if (ERRORS[data.error]) return ERRORS[data.error];
  if (typeof data.message === "string" && data.message) return data.message;
  if (err && err.status === 409) return ERRORS.busy;
  if (err && err.status) return "Algo salió mal en tu computadora. Intenta de nuevo.";
  return "No pude conectarme con el panel. Revisa tu conexión local e intenta de nuevo.";
}

// ---------- status ----------
export function viewMode(status) {
  if ((status.run && status.run.status === "running") || status.probing) return "running";
  return status.has_proposals ? "proposals" : "empty";
}

export function validationNotice(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  return {
    title: "La última propuesta no era válida",
    items: errors.slice(0, MAX_VALIDATION_SHOWN).map((e) => String(e.message || "")),
    more: Math.max(0, errors.length - MAX_VALIDATION_SHOWN),
  };
}

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
export function formatGenerated(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
  if (!m) return "";
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} de ${month} de ${m[1]}` : "";
}

// ---------- progress ----------
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
