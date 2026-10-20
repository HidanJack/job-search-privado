"use strict";

// All posting-derived text is untrusted: it is only ever set via textContent.
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.append(c);
  return node;
};

const SVG_NS = "http://www.w3.org/2000/svg";
const icon = (name) => {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
};

// ---------- motion helpers (presentation only) ----------
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
// Counts a number up so the eye can see its size. The final value is always in the
// DOM for assistive tech; the animated copy is aria-hidden. Skipped under reduced motion.
function countUp(node, final, format, { delay = 0, duration = 800 } = {}) {
  node.textContent = format(final);
  if (reduceMotion() || !(final > 0)) return;
  const live = el("span", { "aria-hidden": "true", text: format(0) });
  const sr = el("span", { class: "sr-only", text: format(final) });
  node.replaceChildren(live, sr);
  const start = performance.now() + delay;
  const tick = (now) => {
    const t = Math.max(0, Math.min(1, (now - start) / duration));
    live.textContent = format(Math.round(final * easeOutCubic(t)));
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
const NUMBER_WORDS = ["Ninguna", "Una", "Dos", "Tres", "Cuatro", "Cinco", "Seis", "Siete", "Ocho", "Nueve", "Diez"];
const dayFmt = new Intl.DateTimeFormat("es-MX", { weekday: "long", day: "numeric", month: "long" });
const WORTH_SCORE = 75; // same threshold as the "high" score band

// ---------- theme (explicit choice persisted; otherwise follow the OS) ----------
const THEME_KEY = "job-ui-theme";
const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
function currentTheme() {
  return document.documentElement.dataset.theme || (systemDark() ? "dark" : "light");
}
function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  const btn = document.getElementById("theme-btn");
  if (btn) btn.setAttribute("aria-label", currentTheme() === "dark" ? "Cambiar a modo claro" : "Cambiar a modo oscuro");
}
try {
  applyTheme(localStorage.getItem(THEME_KEY));
} catch {
  /* storage unavailable: follow the OS */
}
function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* choice just won't persist */
  }
}

// ---------- toasts ----------
function toast(text) {
  const box = $("#toasts");
  if (!box) return;
  const t = el("div", { class: "toast", text });
  box.append(t);
  setTimeout(() => {
    t.classList.add("leaving");
    setTimeout(() => t.remove(), 200);
  }, 2600);
}

const MODALITY_LABEL = { remote: "Remoto", hybrid: "Híbrido", onsite: "Presencial", unknown: "Sin especificar" };
const VERDICT_LABEL = {
  "Strong Fit": "Encaje fuerte", "Good Fit": "Buen encaje", "Moderate Fit": "Encaje moderado", "Weak Fit": "Encaje débil", "Poor Fit": "Encaje bajo",
};
const PORTAL_LABEL = {
  getonbrd: "GetOnBoard", himalayas: "Himalayas", remoteok: "Remote OK", jobicy: "Jobicy", "hn-hiring": "Hacker News", linkedin: "LinkedIn", freehire: "Freehire",
};
const JOB_STATUS_LABEL = { new: "Nueva", ranked: "Calificada", expired: "Vencida" };
const verdictLabel = (v) => VERDICT_LABEL[v] || v;
const portalLabel = (p) => {
  const base = String(p || "").trim().replace(/-search$/i, "");
  return PORTAL_LABEL[base.toLowerCase()] || (base ? base.charAt(0).toUpperCase() + base.slice(1) : base);
};
const jobStatusLabel = (s) => JOB_STATUS_LABEL[s] || s;
const STATUS_LABEL = {
  drafted: "Borrador", applied: "Enviada", interview: "Entrevista", offer: "Oferta", hired: "Contratado",
  rejected: "Rechazada", no_response: "Sin respuesta", offer_declined: "Oferta rechazada", withdrawn: "Retirada",
};
const mxn = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });

let state = { profile: null, results: {}, jobs: [] };

// ---------- filters (persisted on the server in ui/state/settings.json; the sweep uses the same window) ----------
let savedFilters = null;
let saveTimer = null;
function loadSavedFilters() {
  return savedFilters;
}
// Form shape <-> stored search settings.
function filtersFromSettings(s) {
  return {
    maxDays: s.maxDays, minSalary: s.minSalaryMxn, includeNoSalary: s.includeUnpublishedSalary,
    includeUndated: s.includeUndated, hideEnglish: s.hideEnglish, modality: s.modalities, rankBatch: s.rankBatch,
    minPrefilterScore: s.minPrefilterScore,
  };
}
function settingsPatch(f) {
  const patch = { includeUnpublishedSalary: f.includeNoSalary, includeUndated: f.includeUndated, hideEnglish: f.hideEnglish, modalities: f.modality };
  const days = Number(f.maxDays);
  if (f.maxDays !== "" && Number.isInteger(days) && days >= 1 && days <= 90) patch.maxDays = days;
  const batch = Number(f.rankBatch);
  if (f.rankBatch !== "" && f.rankBatch !== undefined && Number.isInteger(batch) && batch >= 1 && batch <= 200) patch.rankBatch = batch;
  const gate = Number(f.minPrefilterScore);
  if (f.minPrefilterScore !== "" && f.minPrefilterScore !== undefined && Number.isInteger(gate) && gate >= 0 && gate <= 100) patch.minPrefilterScore = gate;
  const pay = Number(f.minSalary);
  if (f.minSalary !== "" && Number.isInteger(pay) && pay >= 0 && pay <= 1000000) patch.minSalaryMxn = pay;
  return patch;
}
function saveFilters(f) {
  savedFilters = f;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api("/api/search-settings", settingsPatch(f)).catch(() => toast("No se pudieron guardar tus filtros"));
  }, 400);
}
function renderCoverage(last) {
  const p = $("#coverage");
  if (!last || !last.coverage) {
    p.hidden = true;
    return;
  }
  const when = new Date(last.finishedAt).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
  const failed = last.failures ? ` (${last.failures} consultas fallaron y se omitieron)` : "";
  p.textContent = `Cobertura · ${last.coverage}${failed} Ventana: ${last.maxDays} días · ${when}`;
  p.hidden = false;
}
async function refreshCoverage() {
  try {
    renderCoverage((await api("/api/search-settings")).lastSweep);
  } catch {
    /* the line is a nicety */
  }
}
function readFilterForm() {
  const form = $("#filters");
  return {
    maxDays: form.maxDays.value,
    minSalary: form.minSalary.value,
    rankBatch: form.rankBatch.value,
    minPrefilterScore: form.minPrefilterScore.value,
    includeNoSalary: form.includeNoSalary.checked,
    includeUndated: form.includeUndated.checked,
    hideEnglish: form.hideEnglish.checked,
    modality: [...form.querySelectorAll("input[name=modality]:checked")].map((i) => i.value),
  };
}
function fillFilterForm(f) {
  const form = $("#filters");
  form.maxDays.value = f.maxDays;
  form.minSalary.value = f.minSalary;
  form.rankBatch.value = f.rankBatch ?? 10;
  form.minPrefilterScore.value = f.minPrefilterScore ?? 55;
  form.includeNoSalary.checked = f.includeNoSalary;
  form.includeUndated.checked = f.includeUndated;
  form.hideEnglish.checked = f.hideEnglish !== false; // filters saved before this option existed: on
  for (const i of form.querySelectorAll("input[name=modality]")) i.checked = f.modality.includes(i.value);
}
function filterQuery(f) {
  const p = new URLSearchParams();
  if (f) {
    if (f.maxDays !== "") p.set("maxDays", f.maxDays);
    if (f.minSalary !== "") p.set("minSalary", f.minSalary);
    p.set("includeNoSalary", f.includeNoSalary ? "1" : "0");
    p.set("includeUndated", f.includeUndated ? "1" : "0");
    p.set("hideEnglish", f.hideEnglish === false ? "0" : "1");
    p.set("modality", f.modality.join(","));
  }
  return p.toString();
}

// ---------- API ----------
async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

// ---------- daily automation ----------
const whenFmt = new Intl.DateTimeFormat("es-MX", {
  weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
});
const whenLabel = (iso) => whenFmt.format(new Date(iso)).replace(/\./g, "");

function renderDaily(status) {
  const panel = $("#daily");
  if (!status.available) {
    panel.hidden = true;
    $("#daily-unavailable").hidden = false;
    return;
  }
  panel.hidden = false;
  $("#daily-unavailable").hidden = true;
  const sw = $("#daily-switch");
  sw.setAttribute("aria-checked", String(status.enabled));
  $("#tick-daily").textContent = status.enabled ? "Búsqueda diaria activa" : "Búsqueda diaria apagada";
  $("#tick-dot").classList.toggle("is-live", Boolean(status.enabled));
  $("#daily-next").textContent = status.enabled
    ? status.nextRun ? `Próxima: ${whenLabel(status.nextRun)}` : "Próxima: por programar"
    : "Apagada";
  const last = $("#daily-last");
  last.className = "";
  last.textContent = "";
  if (status.lastResult) {
    const r = status.lastResult;
    const when = status.lastRun ? ` (${whenLabel(status.lastRun)})` : "";
    last.textContent = r.ok ? `Última corrida: bien${when}` : `Última corrida: falló en ${r.step}${when}`;
    if (!r.ok) last.className = "bad";
  }
}

async function refreshDaily() {
  try {
    renderDaily(await api("/api/daily"));
  } catch {
    $("#daily").hidden = true;
  }
}

async function toggleDaily() {
  const sw = $("#daily-switch");
  const next = sw.getAttribute("aria-checked") !== "true";
  sw.disabled = true;
  try {
    renderDaily(await api("/api/daily", { enabled: next }));
    toast(next ? "Búsqueda diaria activada: corre a las 9:00" : "Búsqueda diaria apagada");
  } catch {
    toast("No se pudo cambiar la búsqueda diaria");
  } finally {
    sw.disabled = false;
  }
}

// ---------- jobs ----------
function ageLabel(days) {
  if (days === null || days === undefined) return "fecha no publicada";
  if (days === 0) return "publicada hoy";
  if (days === 1) return "hace 1 día";
  return `hace ${days} días`;
}
function salaryLabel(j) {
  if (j.salary_mxn_month === null) {
    return j.salary_min || j.salary_max ? "Sueldo publicado sin conversión a MXN" : "Sueldo no publicado";
  }
  let text = `${mxn.format(j.salary_mxn_month)} al mes`;
  if (j.salary_currency && j.salary_currency !== "MXN") {
    const range = [j.salary_min, j.salary_max].filter((x) => x !== null).join("–");
    text += ` (original: ${range} ${j.salary_currency}${j.salary_period ? " / " + j.salary_period : ""})`;
  }
  return text;
}
function fillList(ul, items, empty) {
  ul.replaceChildren(...(items.length ? items : [empty]).map((t) => el("li", { text: t })));
}
// Salary as a big figure plus a small qualifier; unknown salaries stay a plain phrase.
function salaryParts(j) {
  if (j.salary_mxn_month === null) return { main: salaryLabel(j), sub: "", value: null };
  let sub = "MXN al mes";
  if (j.salary_currency && j.salary_currency !== "MXN") {
    const range = [j.salary_min, j.salary_max].filter((x) => x !== null).join("–");
    sub += ` · original: ${range} ${j.salary_currency}${j.salary_period ? " / " + j.salary_period : ""}`;
  }
  return { main: mxn.format(j.salary_mxn_month), sub, value: j.salary_mxn_month };
}

function emptyState(pending) {
  const steps = [];
  if (pending) {
    steps.push({ title: "Calificar pendientes", note: `${pending} ${pending === 1 ? "vacante cumple" : "vacantes cumplen"} el puntaje mínimo y ${pending === 1 ? "espera" : "esperan"} su calificación (se califican por tandas). Tarda unos minutos.`, action: "Calificar las mejores", run: startRank, primary: true });
    steps.push({ title: "Buscar vacantes nuevas", note: "Rastrea los portales de nuevo. Tarda unos minutos.", action: "Buscar ahora", run: startSearch });
  } else {
    steps.push({ title: "Buscar vacantes nuevas", note: "Rastrea los portales de nuevo. Tarda unos minutos.", action: "Buscar ahora", run: startSearch, primary: true });
  }
  const list = el("ol", { class: "steps" });
  steps.forEach((s, i) => {
    const btn = el("button", { type: "button", class: "step-action" }, el("span", { text: s.action }), el("span", { class: "arrow", "aria-hidden": "true", text: "→" }));
    btn.addEventListener("click", s.run);
    list.append(el("li", { class: `step${s.primary ? " is-primary" : ""}` },
      el("span", { class: "step-num", "aria-hidden": "true", text: String(i + 1).padStart(2, "0") }),
      el("div", { class: "step-body" }, el("h4", { text: s.title }), el("p", { text: s.note })),
      btn));
  });
  return el("div", { class: "empty" },
    el("h3", { text: pending ? `Tienes ${pending} ${pending === 1 ? "vacante" : "vacantes"} sin calificar` : "Nada por aquí con estos filtros" }),
    pending ? null : el("p", { text: "Prueba bajar el sueldo mínimo, subir los días de publicación o desmarcar «Ocultar vacantes en inglés»." }),
    list);
}

// Headline, note and big figure above the list: what today's list is worth.
function renderLead(data) {
  const scored = data.ranked.filter((j) => typeof j.rank_score === "number");
  const worth = scored.filter((j) => j.rank_score >= WORTH_SCORE);
  const n = worth.length;
  const a = $("#lead-a");
  const b = $("#lead-b");
  if (!data.ranked.length) {
    a.textContent = "Aún no hay nada que leer.";
    b.textContent = "Busca o califica para llenar el libro.";
  } else if (!n) {
    a.textContent = `Ninguna vacante llega a ${WORTH_SCORE} puntos.`;
    b.textContent = "Puedes revisar las demás o buscar más.";
  } else {
    a.textContent = `${NUMBER_WORDS[n] || n} ${n === 1 ? "vacante vale" : "vacantes valen"} tu tiempo.`;
    b.textContent = n === data.ranked.length ? "Y ninguna más cumple tus filtros." : "El resto puede esperar.";
  }
  const fresh = data.ranked.filter((j) => j.age_days !== null && j.age_days <= data.filters.maxDays).length;
  $("#lead-note").textContent = data.ranked.length
    ? `${fresh ? `${fresh} ${fresh === 1 ? "vacante nueva" : "vacantes nuevas"} en los últimos ${data.filters.maxDays} días. ` : ""}Van ordenadas por qué tan bien encajan con tu experiencia, no por quién pagó más por aparecer primero.`
    : "Cada vacante se califica contra tu perfil: encaje, sueldo y lo que te falta.";
  const pool = (n ? worth : scored).map((j) => j.salary_mxn_month).filter((v) => typeof v === "number");
  const fig = $("#lead-fig");
  fig.hidden = !pool.length;
  if (pool.length) {
    const top = Math.max(...pool);
    if (state.painted) $("#lead-fig-num").textContent = mxn.format(top); // animate on first load only
    else countUp($("#lead-fig-num"), top, (v) => mxn.format(v), { delay: 420, duration: 1100 });
  }
  $("#lead").classList.add("ready");

  // Day ticker: the same facts in one thin line.
  $("#ticker").hidden = false;
  $("#tick-date").textContent = dayFmt.format(new Date());
  $("#tick-new").textContent = `${fresh} ${fresh === 1 ? "nueva" : "nuevas"}`;
  const best = scored.reduce((m, j) => (m && m.rank_score >= j.rank_score ? m : j), null);
  $("#tick-best").textContent = best ? `Mejor encaje: ${best.rank_score} de 100` : "Sin vacantes calificadas";
}

function renderJobs(data) {
  state.profile = data.profile;
  state.results = data.results || {};
  state.jobs = data.ranked.concat(data.unranked);
  $("#profile-banner").hidden = data.profile.ready;
  const box = $("#jobs");
  const first = !state.painted;
  box.classList.toggle("is-first", first);
  box.replaceChildren();
  box.setAttribute("aria-busy", "false");
  const tpl = $("#card-tpl");
  const rulers = [];
  let index = 0;
  for (const j of data.ranked) {
    const card = tpl.content.firstElementChild.cloneNode(true);
    $(".title", card).textContent = j.title;
    $(".company", card).textContent = j.company || "Empresa no indicada";
    const loc = $(".location", card);
    if (j.location) $(".location-text", card).textContent = j.location;
    else loc.classList.add("is-empty");
    const score = $(".score", card);
    const hasScore = typeof j.rank_score === "number";
    $(".score-num", score).textContent = hasScore ? String(j.rank_score) : "—";
    score.setAttribute("aria-label", hasScore ? `Encaje: ${j.rank_score} de 100` : "Sin puntaje");
    score.classList.add(!hasScore ? "is-empty" : j.rank_score >= WORTH_SCORE ? "high" : j.rank_score >= 60 ? "mid" : "low");
    $(".score-label", score).textContent = j.rank_verdict ? verdictLabel(j.rank_verdict) : "de 100 en encaje";
    const delay = first ? 380 + index * 70 : 0;
    card.style.setProperty("--i", String(index));
    const pct = hasScore ? Math.max(0, Math.min(100, j.rank_score)) : 0;
    if (hasScore && first && index < 8) {
      rulers.push([$(".ruler", score), pct]);
      countUp($(".score-num", score), j.rank_score, String, { delay: delay + 150, duration: 900 });
    } else {
      $(".ruler", score).style.setProperty("--s", `${pct}%`);
    }
    index += 1;
    const meta = $(".meta", card);
    if (j.age_days !== null && j.age_days <= data.filters.maxDays) meta.append(el("span", { class: "chip new", text: "Nueva" }));
    meta.append(
      el("span", { class: "chip", text: MODALITY_LABEL[j.modality] }),
      el("span", { class: "chip", text: ageLabel(j.age_days) }),
      el("span", { class: "chip", text: j.portal ? portalLabel(j.portal) : "portal desconocido" }),
    );
    if (j.role_family) meta.append(el("span", { class: "chip family", text: j.role_family }));
    if (j.spoken_english) meta.append(el("span", { class: "chip warn", text: "Inglés hablado", title: j.language_note || "" }));
    fillIndicators($(".indicators", card), j);
    const salary = $(".salary", card);
    const pay = salaryParts(j);
    $(".pay-sub", salary).textContent = pay.sub;
    if (pay.value !== null && first && index <= 8) countUp($(".pay-main", salary), pay.value, (v) => mxn.format(v), { delay: delay + 250, duration: 900 });
    else $(".pay-main", salary).textContent = pay.main;
    salary.classList.toggle("unknown", j.salary_mxn_month === null);
    fillList($(".reasons", card), j.fit_reasons.length ? j.fit_reasons : j.strengths, "Sin detalle; vuelve a calificar con Buscar ahora.");
    fillList($(".gaps", card), j.gaps, "Nada importante.");
    const link = $(".link", card);
    if (j.url) link.href = j.url;
    else link.remove();
    const applyBtn = $(".apply-btn", card);
    const reviewBtn = $(".review-btn", card);
    if (!j.url) applyBtn.disabled = true;
    applyBtn.addEventListener("click", () => startApply(j.url, { title: `${j.title} — ${j.company}` }));
    if (j.url && state.results[j.url]) {
      reviewBtn.hidden = false;
      applyBtn.textContent = "Volver a generar";
      reviewBtn.addEventListener("click", () => openReview(j.url, state.results[j.url], `${j.title} — ${j.company}`));
    }
    $(".skip-btn", card).addEventListener("click", async () => {
      await api("/api/jobs/skip", { key: j.key });
      toast("Vacante descartada");
      refreshJobs();
    });
    box.append(card);
  }
  const pending = data.counts ? data.counts.pending : data.unranked.length;
  state.counts = data.counts || { pending, rankedTotal: data.ranked.length };
  const eligible = data.counts && data.counts.eligible !== undefined ? data.counts.eligible : pending;
  if (!data.ranked.length) box.append(emptyState(eligible));
  const rankBtn = $("#rank-btn");
  rankBtn.hidden = eligible === 0;
  $("span", rankBtn).textContent = `Calificar las mejores ${Math.min(data.rankBatch || 10, eligible)}`;
  // Draw the graduated rulers after paint so they sweep in from zero (first load only).
  requestAnimationFrame(() => requestAnimationFrame(() => {
    for (const [ruler, value] of rulers) ruler.style.setProperty("--s", `${value}%`);
  }));
  renderLead(data);
  state.painted = true;
  const f = data.filters;
  $("#jobs-summary").textContent = data.ranked.length
    ? `${data.ranked.length} ${data.ranked.length === 1 ? "vacante cumple" : "vacantes cumplen"} tus filtros (máx. ${f.maxDays} días, desde ${mxn.format(f.minSalaryMxn)} al mes), ordenadas por prioridad.`
    : "";

  renderPrefiltered(data);
  renderGated(data);
  const ul = $("#unranked");
  ul.replaceChildren(...data.unranked.map((j) => {
    const li = el("li");
    const a = el("a", { text: `${j.title} — ${j.company}`, target: "_blank", rel: "noopener noreferrer" });
    if (j.url) a.href = j.url;
    li.append(a, document.createTextNode(` (${ageLabel(j.age_days)})`));
    const why = prefilterWhy(j);
    if (why) li.title = why;
    return li;
  }));
  $("#unranked-summary").textContent = queueSummary(pending, data.rankBatch, data.counts && data.counts.prefilteredOut, eligible, data.minPrefilterScore);
}

// Tooltip for the queue: the prefilter score plus what the learned scorer says moves it.
function prefilterWhy(j) {
  const why = (j.prefilter_why || []).join("; ");
  if (typeof j.prefilter_score !== "number") return why;
  return `Puntaje previo ${j.prefilter_score}${why ? ` · ${why}` : ""}`;
}

// "10 de 340 pendientes cumplen el puntaje mínimo (52) · Y descartadas automáticamente"
function queueSummary(pending, batch, discarded, eligible, minScore) {
  const ready = eligible === undefined ? pending : eligible;
  const first = Math.min(batch || 10, ready);
  const parts = [];
  if (ready === pending) {
    parts.push(`${pending} ${pending === 1 ? "vacante por calificar" : "vacantes por calificar"}${pending > first ? ` (las mejores ${first} primero)` : ""}`);
  } else {
    const gate = minScore === undefined ? "" : ` (${minScore})`;
    parts.push(`${first} de ${pending} ${pending === 1 ? "pendiente cumple" : "pendientes cumplen"} el puntaje mínimo${gate}${ready > first ? `; hay ${ready} que lo cumplen y se califican por tandas` : ""}`);
  }
  if (discarded) parts.push(`${discarded} ${discarded === 1 ? "descartada" : "descartadas"} automáticamente`);
  return parts.join(" · ");
}

// Oportunidad / Riesgo: two compact labeled indicators plus the biggest driver of each.
function fillIndicators(box, j) {
  if (typeof j.opportunity !== "number" || typeof j.risk !== "number") return;
  box.hidden = false;
  $(".ind-opp-num", box).textContent = String(j.opportunity);
  $(".ind-risk-num", box).textContent = String(j.risk);
  $(".ind-opp-why", box).textContent = j.opportunity_driver ? `Oportunidad: ${j.opportunity_driver}` : "";
  $(".ind-risk-why", box).textContent = j.risk_driver ? `Riesgo: ${j.risk_driver}` : "";
  box.title = typeof j.final_priority === "number" ? `Prioridad final: ${j.final_priority} (oportunidad ajustada por riesgo)` : "";
}

function renderPrefiltered(data) {
  const list = data.prefiltered || [];
  const box = $("#prefiltered-box");
  box.hidden = list.length === 0;
  $("#prefiltered-summary").textContent = `Descartadas automáticamente (${list.length})`;
  $("#prefiltered").replaceChildren(...list.map((j) => {
    const li = el("li", { class: "has-action" });
    const text = el("span");
    const a = el("a", { text: `${j.title} — ${j.company}`, target: "_blank", rel: "noopener noreferrer" });
    if (j.url) a.href = j.url;
    text.append(a, el("span", { class: "prefilter-reason", text: ` · ${j.prefilter_reason || "Fuera de perfil"}` }));
    const btn = el("button", { type: "button", class: "ghost small recover-btn", text: "Recuperar" });
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api("/api/jobs/recover", { key: j.key });
        toast("Vacante recuperada: volvió a la fila para calificar");
        refreshJobs();
      } catch {
        btn.disabled = false;
        toast("No se pudo recuperar la vacante");
      }
    });
    li.append(text, btn);
    return li;
  }));
}

function renderGated(data) {
  const list = data.gated || [];
  const box = $("#gated-box");
  box.hidden = list.length === 0;
  $("#gated-summary").textContent = `Con poco encaje aparente (${list.length}): no se califican solas`;
  $("#gated").replaceChildren(...list.map((j) => {
    const li = el("li", { class: "has-action" });
    const text = el("span");
    const a = el("a", { text: `${j.title} — ${j.company}`, target: "_blank", rel: "noopener noreferrer" });
    if (j.url) a.href = j.url;
    const why = (j.prefilter_why || []).join("; ");
    text.append(a, el("span", { class: "gate-score", text: ` · puntaje ${j.prefilter_score}${why ? ` · ${why}` : ""}`, title: prefilterWhy(j) }));
    const btn = el("button", { type: "button", class: "ghost small recover-btn", text: "Calificar esta" });
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api("/api/jobs/force-rank", { key: j.key });
        toast("Lista: entrará en la próxima calificación");
        refreshJobs();
      } catch {
        btn.disabled = false;
        toast("No se pudo marcar la vacante");
      }
    });
    li.append(text, btn);
    return li;
  }));
}

async function refreshJobs() {
  try {
    renderJobs(await api(`/api/jobs?${filterQuery(loadSavedFilters())}`));
  } catch (err) {
    $("#jobs-summary").textContent = `No se pudieron cargar las vacantes: ${err.message}`;
  }
}

// ---------- runs (SSE progress) ----------
function setRunStatus(text, kind) {
  const pill = $("#run-status");
  pill.textContent = text;
  pill.classList.toggle("ok", kind === "ok");
  pill.classList.toggle("err", kind === "err");
  $("#run-panel").classList.toggle("is-done", kind !== "running");
}
function showRunPanel(title) {
  $("#run-panel").hidden = false;
  $("#run-title").textContent = title;
  setRunStatus("en curso", "running");
  $("#run-close").hidden = true;
  $("#run-log").replaceChildren();
  $("#run-cost").hidden = true;
  $("#run-details").open = false;
  setRunButtons(true);
}
function setRunButtons(disabled) {
  $("#search-btn").disabled = disabled;
  $("#rank-btn").disabled = disabled;
  $("#skills-refresh").disabled = disabled;
  for (const b of document.querySelectorAll(".apply-btn, .steps button")) b.disabled = disabled;
}
function followRun(id, onEnd) {
  const log = $("#run-log");
  const source = new EventSource(`/api/run/events?id=${encodeURIComponent(id)}`);
  source.onmessage = (msg) => {
    const e = JSON.parse(msg.data);
    if (e.type === "end") {
      source.close();
      if (e.run.status === "done") setRunStatus("terminado", "ok");
      else setRunStatus("con errores", "err");
      $("#run-close").hidden = false;
      setRunButtons(false);
      onEnd(e.run);
      return;
    }
    if (e.type === "cost") {
      $("#run-cost").textContent = e.text;
      $("#run-cost").hidden = false;
    }
    log.append(el("li", { class: e.type, text: e.text }));
    log.scrollTop = log.scrollHeight;
  };
  source.onerror = () => {
    source.close();
    setRunStatus("se perdió la conexión", "err");
    $("#run-close").hidden = false;
    setRunButtons(false);
  };
}
function runError(err) {
  if (err.status === 409) alertInline("Ya hay una tarea en curso; espera a que termine.");
  else alertInline(`No se pudo iniciar: ${err.message}`);
}
function alertInline(text) {
  $("#run-panel").hidden = false;
  $("#run-title").textContent = text;
  setRunStatus("", "idle");
  $("#run-close").hidden = false;
}

// Reload the list after a search/rank run and say how many postings got a score.
async function reportRanked(before) {
  await refreshJobs();
  await refreshCoverage();
  const after = state.counts || before;
  const ranked = Math.max(0, after.rankedTotal - before.rankedTotal);
  const found = Math.max(0, (after.rankedTotal + after.pending) - (before.rankedTotal + before.pending));
  if (ranked) toast(`${ranked} ${ranked === 1 ? "vacante calificada" : "vacantes calificadas"}${found ? ` (${found} nuevas encontradas)` : ""}`);
  else if (found) toast(`${found} ${found === 1 ? "vacante nueva encontrada" : "vacantes nuevas encontradas"}, sin calificar todavía`);
  else toast("Sin vacantes nuevas calificadas");
}

async function startSearch() {
  const before = { ...(state.counts || { pending: 0, rankedTotal: 0 }) };
  try {
    const { id } = await api("/api/run/search", {});
    showRunPanel("Barriendo los portales, buscando en Indeed y calificando — puede tardar varios minutos");
    followRun(id, () => reportRanked(before));
  } catch (err) {
    runError(err);
  }
}

async function startRank() {
  const before = { ...(state.counts || { pending: 0, rankedTotal: 0 }) };
  try {
    const { id } = await api("/api/run/rank", {});
    showRunPanel("Calificando vacantes pendientes — puede tardar varios minutos");
    followRun(id, () => reportRanked(before));
  } catch (err) {
    runError(err);
  }
}

async function startApply(url, { title, acknowledgeKnockouts = false, feedback = "" }) {
  try {
    const { id } = await api("/api/run/apply", { url, acknowledgeKnockouts, feedback });
    $("#review").close();
    showRunPanel(`Preparando CV y carta: ${title}`);
    followRun(id, async (run) => {
      await refreshJobs();
      if (run.result) openReview(url, run.result, title);
      else alertInline("La ejecución terminó sin un resultado legible. Revisa el registro de arriba.");
    });
  } catch (err) {
    runError(err);
  }
}

// ---------- review ----------
function section(title, ...children) {
  return el("section", {}, el("h4", { text: title }), ...children);
}
function knockoutTable(list) {
  const table = el("table", { class: "table" });
  table.append(el("tr", {}, el("th", { text: "Requisito" }), el("th", { text: "Tú" })));
  const label = { meets: "Cumples", "does not meet": "No cumples", unclear: "No está claro" };
  const tone = { meets: "ko-yes", "does not meet": "ko-no", unclear: "ko-unclear" };
  for (const k of list) {
    const answer = el("span", { class: `status-tag ${tone[k.answer] || ""}`, text: label[k.answer] || k.answer });
    table.append(el("tr", {}, el("td", { text: k.requirement }), el("td", {}, answer)));
  }
  return table;
}
function docFrame(label, path) {
  const src = `/api/file?path=${encodeURIComponent(path)}`;
  return el("div", { class: "doc" },
    el("h4", { text: label }),
    el("iframe", { src, title: label }),
    el("a", { class: "link", href: `${src}&download=1`, text: `Descargar ${label.toLowerCase()}` }));
}
async function formFieldsBlock(path) {
  try {
    const { text } = await api(`/api/form-fields?path=${encodeURIComponent(path)}`);
    const pre = el("pre", { text });
    const btn = el("button", { type: "button", text: "Copiar respuestas" });
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = "Copiado";
        toast("Respuestas copiadas");
      } catch {
        btn.textContent = "Selecciona y copia a mano";
      }
    });
    return section("Respuestas para el formulario", el("div", { class: "copy-block" }, btn, pre));
  } catch {
    return null;
  }
}

async function openReview(url, result, title) {
  const body = $("#review-body");
  body.replaceChildren();
  $("#review-title").textContent = title || [result.role, result.company].filter(Boolean).join(" — ") || "Revisión";
  if (result.message) body.append(el("p", { text: result.message }));

  if (result.knockouts?.length) body.append(section("Requisitos eliminatorios", knockoutTable(result.knockouts)));

  if (result.stage === "knockout") {
    const go = el("button", { type: "button", class: "primary", text: "Continuar de todos modos" });
    go.addEventListener("click", () => startApply(url, { title, acknowledgeKnockouts: true }));
    const drop = el("button", { type: "button", class: "ghost", text: "Mejor no" });
    drop.addEventListener("click", () => $("#review").close());
    body.append(el("p", { class: "notice warn", text: "No cumples al menos un requisito eliminatorio: los ATS suelen rechazar en automático por esto, sin importar el resto del perfil." }), el("div", { class: "actions" }, go, drop));
    $("#review").showModal();
    return;
  }
  if (result.stage === "error") {
    body.append(el("p", { class: "notice warn", text: "No se pudieron generar los documentos. Puedes intentar de nuevo." }));
    $("#review").showModal();
    return;
  }

  const docs = el("div", { class: "docs" });
  if (result.cv_pdf) docs.append(docFrame("CV", result.cv_pdf));
  if (result.cover_pdf) docs.append(docFrame("Carta", result.cover_pdf));
  body.append(docs);
  if (!result.cover_pdf && result.cover_letter_skipped_reason) {
    body.append(el("p", { class: "muted", text: `Sin carta: ${result.cover_letter_skipped_reason}` }));
  }
  if (result.keywords) {
    const kw = el("p");
    kw.append(el("strong", { text: "Palabras clave cubiertas: " }), document.createTextNode(result.keywords.covered.join(", ") || "—"));
    const miss = el("p");
    miss.append(el("strong", { text: "Faltantes (huecos reales, no se inventan): " }), document.createTextNode(result.keywords.missing.join(", ") || "—"));
    body.append(section("Keywords del ATS", kw, miss));
  }
  if (result.questions?.length) {
    const ul = el("ul");
    fillList(ul, result.questions, "");
    body.append(section("Preguntas pendientes para ti", ul));
  }
  if (result.form_fields) {
    const block = await formFieldsBlock(result.form_fields);
    if (block) body.append(block);
  }

  const approve = el("button", { type: "button", class: "primary", text: "Aprobar y postular" });
  const changes = el("button", { type: "button", text: "Pedir cambios" });
  const discard = el("button", { type: "button", class: "ghost danger", text: "Descartar" });
  const feedbackBox = el("div", {});
  feedbackBox.hidden = true;
  const textarea = el("textarea", { placeholder: "¿Qué quieres que cambie? Ej.: resalta más Kubernetes, quita el párrafo de Knoto…", maxlength: "2000" });
  const sendFeedback = el("button", { type: "button", class: "primary", text: "Regenerar con estos cambios" });
  feedbackBox.append(textarea, el("div", { class: "actions" }, sendFeedback));
  const status = el("p", { class: "status-line" });

  approve.addEventListener("click", async () => {
    // Open synchronously inside the click so the browser does not block the tab.
    window.open(url, "_blank", "noopener,noreferrer");
    try {
      await api("/api/applications/approve", { url });
      status.textContent = "Listo: se abrió la vacante y la marqué como enviada. Sube los archivos de arriba en el formulario.";
      toast("Marcada como enviada");
    } catch (err) {
      status.textContent = err.data?.error === "row_not_found"
        ? "Se abrió la vacante, pero no encontré su fila en borrador en el tracker; márcala con /outcome."
        : `Se abrió la vacante, pero no pude actualizar el tracker (${err.message}).`;
    }
    refreshTracking();
  });
  changes.addEventListener("click", () => {
    feedbackBox.hidden = false;
    textarea.focus();
  });
  sendFeedback.addEventListener("click", () => {
    const text = textarea.value.trim();
    if (text) startApply(url, { title, acknowledgeKnockouts: true, feedback: text });
  });
  discard.addEventListener("click", async () => {
    const job = state.jobs.find((j) => j.url === url);
    if (job) await api("/api/jobs/skip", { key: job.key }).catch(() => {});
    $("#review").close();
    refreshJobs();
  });

  body.append(
    el("p", { class: "notice", text: "El envío no es automático: casi ningún portal lo permite sin arriesgar tu cuenta. Al aprobar se abre la vacante con todo listo para que subas los archivos (unos 2 minutos)." }),
    el("div", { class: "actions" }, approve, changes, discard),
    feedbackBox,
    status,
  );
  $("#review").showModal();
}

// ---------- tracking ----------
function rateTable(table, rates, label) {
  table.replaceChildren(el("tr", {}, el("th", { text: label }), el("th", { text: "Enviadas" }), el("th", { text: "Con respuesta" }), el("th", { text: "Tasa" })));
  const entries = Object.entries(rates).sort((a, b) => b[1].sent - a[1].sent);
  if (!entries.length) table.append(el("tr", {}, el("td", { colspan: "4", class: "muted", text: "Todavía no hay aplicaciones enviadas." })));
  for (const [name, r] of entries) {
    const pct = Math.round(r.rate * 100);
    const fill = el("span");
    fill.style.width = `${pct}%`;
    const rate = el("div", { class: "rate" }, el("div", { class: "rate-bar" }, fill), el("span", { text: `${pct}%` }));
    table.append(el("tr", {}, el("td", { text: name }), el("td", { text: String(r.sent) }), el("td", { text: String(r.responded) }), el("td", {}, rate)));
  }
}
async function refreshTracking() {
  let data;
  try {
    data = await api("/api/tracker");
  } catch {
    return;
  }
  $("#pipeline").replaceChildren(...Object.entries(data.pipeline)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => el("div", { class: `stage s-${s}` }, el("strong", { text: String(n) }), el("span", { text: STATUS_LABEL[s] || s }))));
  if (!$("#pipeline").children.length) $("#pipeline").append(el("p", { class: "muted", text: "Todavía no hay aplicaciones registradas." }));
  rateTable($("#by-channel"), data.byChannel, "Canal");
  rateTable($("#by-portal"), Object.fromEntries(Object.entries(data.byPortal).map(([k, v]) => [portalLabel(k), v])), "Portal");
  const rows = $("#tracker-rows");
  rows.replaceChildren(el("tr", {}, ...["Fecha", "Empresa", "Puesto", "Estado", "Canal", "Encaje"].map((h) => el("th", { text: h }))));
  for (const r of [...data.rows].reverse()) {
    const status = (r.status || "").trim().toLowerCase().replace(/\s+/g, "_");
    const tag = el("span", { class: `status-tag s-${status}`, text: STATUS_LABEL[status] || r.status || "" });
    rows.append(el("tr", {},
      ...[r.date, r.company, r.role].map((v) => el("td", { text: v || "" })),
      el("td", {}, tag),
      ...[r.channel, r.fit_rating].map((v) => el("td", { text: v || "" }))));
  }
}

// ---------- market ----------
const MK = {
  data: null, tipIndex: new Map(), resizeTimer: 0,
  ROW_H: 68, LANE_PAD: 26, DOT_R: 6, TOP: 46, AXIS_H: 30, PAD_X: 14,
};
const moneyFull = (n) => `$${Math.round(n).toLocaleString("en-US")}`;
const moneyShort = (n) => (n >= 1000 ? `$${+(n / 1000).toFixed(1)}k` : `$${n}`);
const svgEl = (tag, attrs = {}, text) => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (text !== undefined) n.textContent = text;
  return n;
};

/** Log scale whose domain always contains every value that must be drawn. */
function marketDomain(values) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const floors = [5000, 8000, 10000];
  const ceils = [30000, 50000, 100000, 150000, 200000, 300000, 500000, 1000000];
  return [
    [...floors].reverse().find((f) => f <= lo * 0.92) ?? 3000,
    ceils.find((c) => c >= hi * 1.06) ?? 1000000,
  ];
}

const LANES = [
  { id: "local", label: "Tus vacantes no remotas", test: (j) => j.modality !== "remote" },
  { id: "remote", label: "Tus vacantes remotas", test: (j) => j.modality === "remote" },
];
const langLabel = { en: "publicada en inglés", es: "publicada en español", mixed: "publicada en español e inglés" };

function jobTip(j) {
  const mod = j.modality === "remote" ? "Remoto" : MODALITY_LABEL[j.modality] || "Sin especificar";
  return { title: `${j.company}`, lines: [j.title, `${moneyFull(j.salary)} MXN/mes`, `${mod}${j.language ? " · " + langLabel[j.language] : ""}`] };
}
function entryTip(e) {
  const range = e.min !== null ? `${moneyFull(e.min)} a ${moneyFull(e.max)}` : null;
  return {
    title: `${e.role} · ${e.region}`,
    lines: [
      [range && `Rango: ${range}`, e.avg !== null && `Promedio: ${moneyFull(e.avg)}`].filter(Boolean).join(" · "),
      `${e.source}, ${e.date}${e.evidence === "dubious" ? " · Fuente débil" : ""}`,
      e.note,
    ],
  };
}

function renderMarketLegend(settings) {
  const ul = $("#market-legend");
  ul.replaceChildren();
  const item = (svgChild, text) => {
    const s = svgEl("svg", { width: 28, height: 16, viewBox: "0 0 28 16", "aria-hidden": "true" });
    s.append(...svgChild);
    ul.append(el("li", {}, s, el("span", { text })));
  };
  item([svgEl("rect", { x: 1, y: 3, width: 26, height: 10, rx: 3, class: "mk-band" })], "Rango típico");
  item([svgEl("rect", { x: 1, y: 3, width: 26, height: 10, rx: 3, class: "mk-band" }), svgEl("rect", { x: 12, y: 0, width: 4, height: 16, rx: 1, class: "mk-avg" })], "Promedio");
  item([svgEl("rect", { x: 1, y: 3, width: 26, height: 10, rx: 3, class: "mk-weak", fill: "url(#mk-hatch)" })], "Fuente débil");
  item([svgEl("circle", { cx: 14, cy: 8, r: 6, class: "mk-dot mk-local" })], "Vacante local");
  item([svgEl("path", { d: "M14 1.5 20.5 8 14 14.5 7.5 8Z", class: "mk-dot mk-remote" })], "Vacante remota");
  item([svgEl("circle", { cx: 14, cy: 8, r: 5.5, class: "mk-dot mk-local hollow" })], "Hueco: en inglés");
  if (settings.currentSalary > 0) item([svgEl("line", { x1: 2, x2: 26, y1: 8, y2: 8, class: "mk-line today" })], "Tú hoy");
  if (settings.targetSalary > 0) item([svgEl("line", { x1: 2, x2: 26, y1: 8, y2: 8, class: "mk-line goal" })], "Tu objetivo");
}

function renderMarketChart(data) {
  const host = $("#market-chart");
  const tip = el("div", { class: "mk-tip", role: "tooltip", hidden: "" });
  const entries = data.market.entries;
  const s = data.settings;
  const cur = s.currentSalary > 0 ? s.currentSalary : null;
  const goal = s.targetSalary > 0 ? s.targetSalary : null;
  MK.tipIndex = new Map();

  const values = [
    ...entries.flatMap((e) => [e.min, e.max, e.avg].filter((v) => v !== null)),
    ...data.jobs.map((j) => j.salary), ...(cur ? [cur] : []), ...(goal ? [goal] : []),
  ];
  const [lo, hi] = marketDomain(values);
  const W = Math.max(300, host.clientWidth || 640);
  const L = MK.PAD_X, R = MK.PAD_X;
  const x = (v) => L + ((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * (W - L - R);

  // Lanes of jobs: simple beeswarm so equal salaries do not hide each other.
  const lanes = LANES.map((lane) => {
    const jobs = data.jobs.filter(lane.test);
    const levels = [];
    const placed = jobs.map((j) => {
      const px = x(j.salary);
      let lvl = levels.findIndex((last) => px - last >= MK.DOT_R * 2 + 3);
      if (lvl === -1) lvl = levels.length;
      levels[lvl] = px;
      return { j, px, lvl };
    });
    return { lane, placed, levels: Math.max(1, levels.length) };
  }).filter((l) => l.placed.length > 0);

  let y = MK.TOP;
  const laneLayout = lanes.map((l) => {
    const top = y;
    const h = MK.LANE_PAD + l.levels * (MK.DOT_R * 2 + 4) + 8;
    y += h;
    return { ...l, top, h };
  });
  const rowTop = (i) => y + i * MK.ROW_H;
  const plotBottom = y + entries.length * MK.ROW_H;
  const H = plotBottom + MK.AXIS_H;

  const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-labelledby": "mk-title mk-desc" });
  svg.append(svgEl("title", { id: "mk-title" }, "Sueldos de referencia, tus vacantes y tus líneas de sueldo"));
  const bench = entries.find((e) => e.id === "python-mx");
  const desc = [
    bench ? `Referencia principal: Python en México, promedio ${moneyFull(bench.avg)} al mes, rango ${moneyFull(bench.min)} a ${moneyFull(bench.max)}.` : "",
    `${data.jobs.length} vacantes calificadas con sueldo publicado, de ${moneyShort(Math.min(...data.jobs.map((j) => j.salary), Infinity) === Infinity ? 0 : Math.min(...data.jobs.map((j) => j.salary)))} a ${moneyShort(Math.max(0, ...data.jobs.map((j) => j.salary)))}.`,
    cur ? `Tu sueldo actual: ${moneyFull(cur)}.` : "", goal ? `Tu objetivo: ${moneyFull(goal)}.` : "",
    "Los mismos datos están en la tabla de abajo.",
  ].filter(Boolean).join(" ");
  svg.append(svgEl("desc", { id: "mk-desc" }, desc));

  const defs = svgEl("defs");
  const pat = svgEl("pattern", { id: "mk-hatch", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
  pat.append(svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 6, class: "mk-hatch-line" }));
  defs.append(pat);
  svg.append(defs);

  // Grid + axis (log ticks that fall inside the domain).
  const ticks = [5000, 10000, 20000, 30000, 50000, 100000, 200000, 500000, 1000000].filter((t) => t >= lo && t <= hi);
  const grid = svgEl("g", { "aria-hidden": "true" });
  for (const t of ticks) {
    grid.append(svgEl("line", { x1: x(t), x2: x(t), y1: MK.TOP - 8, y2: plotBottom, class: "mk-grid" }));
    const label = svgEl("text", { x: x(t), y: plotBottom + 18, class: "mk-axis", "text-anchor": "middle" }, moneyShort(t));
    grid.append(label);
  }
  svg.append(grid);

  // Reference rows
  entries.forEach((e, i) => {
    const top = rowTop(i);
    const weak = e.evidence === "dubious";
    const g = svgEl("g", { class: `mk-row${weak ? " weak" : ""}`, tabindex: 0, role: "img", "data-tip": `e:${e.id}`,
      "aria-label": `${e.role}, ${e.region}. ${entryTip(e).lines.join(". ")}` });
    MK.tipIndex.set(`e:${e.id}`, entryTip(e));
    g.append(svgEl("rect", { x: 0, y: top, width: W, height: MK.ROW_H - 2, class: "mk-hit" }));
    g.append(svgEl("text", { x: L, y: top + 14, class: "mk-label" }, `${e.role} · ${e.region}`));
    const by = top + 21;
    if (e.min !== null) {
      g.append(svgEl("rect", {
        x: x(e.min), y: by, width: Math.max(2, x(e.max) - x(e.min)), height: 14, rx: 4,
        class: weak ? "mk-weak" : "mk-band", fill: weak ? "url(#mk-hatch)" : null,
      }));
    }
    if (e.avg !== null) {
      g.append(svgEl("rect", { x: x(e.avg) - 4, y: by - 4, width: 8, height: 22, rx: 2, class: "mk-avg-ring" }));
      g.append(svgEl("rect", { x: x(e.avg) - 2, y: by - 3, width: 4, height: 20, rx: 1, class: "mk-avg" }));
    }
    const parts = [
      e.min !== null ? `${moneyShort(e.min)} a ${moneyShort(e.max)}` : null,
      e.avg !== null ? `promedio ${moneyShort(e.avg)}${e.min === null ? " (sin rango)" : ""}` : null,
      e.source,
      weak ? "Fuente débil" : null,
    ].filter(Boolean).join(" · ");
    g.append(svgEl("text", { x: L, y: top + 49, class: `mk-sub${weak ? " weak" : ""}` }, parts));
    svg.append(g);
  });

  // Personal lines
  const lines = svgEl("g");
  const drawLine = (v, cls, text, row) => {
    const px = x(v);
    lines.append(svgEl("line", { x1: px, x2: px, y1: MK.TOP - 10 + 0, y2: plotBottom, class: `mk-line ${cls}` }));
    const right = px > W - 140;
    lines.append(svgEl("text", { x: px + (right ? -6 : 6), y: 14 + row * 16, class: "mk-linelabel", "text-anchor": right ? "end" : "start" }, `${text} ${moneyShort(v)}`));
  };
  if (cur) drawLine(cur, "today", "Tú hoy", 0);
  if (goal) drawLine(goal, "goal", "Tu objetivo", 1);
  svg.append(lines);

  // Job lanes
  for (const l of laneLayout) {
    const lg = svgEl("g");
    lg.append(svgEl("text", { x: L, y: l.top + 14, class: "mk-label" }, `${l.lane.label} (${l.placed.length})`));
    lg.append(svgEl("line", { x1: L, x2: W - R, y1: l.top + l.h - 2, y2: l.top + l.h - 2, class: "mk-lane-sep" }));
    for (const p of l.placed) {
      const cy = l.top + MK.LANE_PAD + MK.DOT_R + p.lvl * (MK.DOT_R * 2 + 4);
      const remote = p.j.modality === "remote";
      const hollow = p.j.language === "en";
      const cls = `mk-dot ${remote ? "mk-remote" : "mk-local"}${hollow ? " hollow" : ""}`;
      const id = `j:${p.j.key}`;
      const tipData = jobTip(p.j);
      MK.tipIndex.set(id, tipData);
      const common = { class: cls, tabindex: 0, role: "img", "data-tip": id, "aria-label": `${tipData.title}. ${tipData.lines.join(". ")}` };
      const r = MK.DOT_R;
      lg.append(remote
        ? svgEl("path", { ...common, d: `M${p.px} ${cy - r - 1.5}L${p.px + r + 1.5} ${cy}L${p.px} ${cy + r + 1.5}L${p.px - r - 1.5} ${cy}Z` })
        : svgEl("circle", { ...common, cx: p.px, cy, r }));
    }
    svg.append(lg);
  }

  if (!MK.drawn) svg.classList.add("draw");
  MK.drawn = true;
  host.replaceChildren(svg, tip);
  host.removeAttribute("aria-busy");

  const show = (target) => {
    const t = MK.tipIndex.get(target.getAttribute("data-tip"));
    if (!t) return;
    tip.replaceChildren(el("strong", { text: t.title }), ...t.lines.filter(Boolean).map((line) => el("span", { text: line })));
    tip.hidden = false;
    const hb = host.getBoundingClientRect();
    const tb = target.getBoundingClientRect();
    const width = tip.offsetWidth;
    const left = Math.min(Math.max(8, tb.left - hb.left + tb.width / 2 - width / 2), hb.width - width - 8);
    const above = tb.top - hb.top - tip.offsetHeight - 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${above >= 0 ? above : tb.bottom - hb.top + 8}px`;
  };
  const hide = () => (tip.hidden = true);
  for (const node of svg.querySelectorAll("[data-tip]")) {
    node.addEventListener("pointerenter", () => show(node));
    node.addEventListener("pointerleave", hide);
    node.addEventListener("focus", () => show(node));
    node.addEventListener("blur", hide);
  }
  svg.addEventListener("keydown", (ev) => ev.key === "Escape" && hide());
}

function renderMarketTables(data) {
  const ref = $("#market-ref-table");
  ref.replaceChildren(el("tr", {}, ...["Rol", "Zona", "Mínimo", "Promedio", "Máximo", "Fuente", "Fecha", "Evidencia"].map((t) => el("th", { text: t }))));
  for (const e of data.market.entries) {
    const money = (v) => (v === null ? "—" : moneyFull(v));
    const src = e.url ? el("a", { href: e.url, target: "_blank", rel: "noopener noreferrer", text: e.source }) : e.source;
    ref.append(el("tr", {},
      el("td", { text: e.role }), el("td", { text: e.region }), el("td", { text: money(e.min) }), el("td", { text: money(e.avg) }),
      el("td", { text: money(e.max) }), el("td", {}, src), el("td", { text: e.date }),
      el("td", { text: e.evidence === "dubious" ? "Fuente débil" : "Verificada" })));
  }
  const jt = $("#market-jobs-table");
  jt.replaceChildren(el("tr", {}, ...["Empresa", "Vacante", "Sueldo (MXN/mes)", "Modalidad", "Idioma"].map((t) => el("th", { text: t }))));
  for (const j of data.jobs) {
    jt.append(el("tr", {}, el("td", { text: j.company }), el("td", { text: j.title }), el("td", { text: moneyFull(j.salary) }),
      el("td", { text: MODALITY_LABEL[j.modality] || "" }), el("td", { text: j.language ? { es: "Español", en: "Inglés", mixed: "Mixto" }[j.language] : "—" })));
  }
  if (!data.jobs.length) jt.append(el("tr", {}, el("td", { colspan: "5", class: "muted", text: "No hay vacantes calificadas con sueldo publicado." })));
}

function renderMarket(data) {
  MK.data = data;
  const form = $("#market-form");
  for (const name of ["currentSalary", "targetSalary"]) {
    if (document.activeElement !== form.elements[name]) form.elements[name].value = data.settings[name] ?? "";
  }
  $("#market-notice").hidden = data.settings.currentSalary > 0 && data.settings.targetSalary > 0;
  renderMarketLegend(data.settings);
  renderMarketChart(data);
  const ul = $("#market-readings");
  ul.replaceChildren(...data.readings.map((t) => el("li", { text: t })));
  renderMarketTables(data);
}

async function refreshMarket() {
  try {
    renderMarket(await api("/api/market"));
  } catch (err) {
    $("#market-chart").textContent = `No se pudo cargar el mercado: ${err.message}`;
  }
}

async function saveMarketSettings() {
  const form = $("#market-form");
  const read = (name) => {
    const raw = form.elements[name].value.trim();
    if (raw === "") return null;
    return /^\d{1,7}$/.test(raw) ? Number(raw) : NaN;
  };
  const body = { currentSalary: read("currentSalary"), targetSalary: read("targetSalary") };
  if ([body.currentSalary, body.targetSalary].some((v) => Number.isNaN(v) || (v !== null && v > 1000000))) {
    toast("Escribe solo números enteros entre 0 y 1,000,000.");
    return;
  }
  try {
    await api("/api/settings", body);
    await refreshMarket();
  } catch {
    toast("No se pudo guardar. Revisa los valores.");
  }
}

// ---------- skills salaries ("Cuánto pagan tus habilidades") ----------
const SK = { data: null };
const SK_WHERE = { mx: "México", latam_local: "LatAm", remote_intl: "Remoto" };
const SK_AXIS_TICKS = [10000, 20000, 30000, 50000, 100000, 200000, 300000, 500000];
const vacantes = (n) => `${n} vacante${n === 1 ? "" : "s"} con sueldo`;
const halfRange = (s) => `La mitad de las vacantes paga entre ${moneyFull(s.p25)} y ${moneyFull(s.p75)} al mes`;

// Shared log-scale axis for every row, so bars are comparable.
function skillsScale(ranked) {
  const vals = ranked.flatMap((r) => r.scopes.flatMap((s) => [s.p25, s.p75]));
  const [lo, hi] = marketDomain(vals.length ? vals : [20000, 60000]);
  const pos = (v) => ((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * 100;
  return { lo, hi, pos, ticks: SK_AXIS_TICKS.filter((t) => t >= lo && t <= hi) };
}

// Positions are set through the CSSOM (inline style attributes are blocked by the CSP).
const placed = (node, left, width) => {
  node.style.left = `${left}%`;
  if (width !== undefined) node.style.width = `${width}%`;
  return node;
};

function skillBar(scale, s) {
  const a = Math.max(0, scale.pos(s.p25));
  const z = Math.min(100, scale.pos(s.p75));
  return el("span", { class: "sk-track", "aria-hidden": "true" },
    ...scale.ticks.map((t) => placed(el("i", { class: "sk-gridline" }), scale.pos(t))),
    placed(el("span", { class: "sk-range", title: halfRange(s) }), a, Math.max(1, z - a)),
    placed(el("span", { class: "sk-median" }), scale.pos(s.median)));
}

function renderSkillsRanked(summary) {
  const scale = skillsScale(summary.ranked);
  $("#skills-axis").replaceChildren(
    el("span", { class: "sk-axis-gutter" }),
    el("span", { class: "sk-axis-scale" }, ...scale.ticks.map((t) => placed(el("span", { class: "sk-tick", text: moneyShort(t) }), scale.pos(t)))),
    el("span", { class: "sk-axis-gutter" }));
  $("#skills-list").replaceChildren(...summary.ranked.map((r) => {
    const best = r.scope;
    const head = el("summary", { class: "sk-row-head" },
      el("span", { class: "sk-name" }, el("strong", { text: r.label }), el("small", { text: `${SK_WHERE[best.group]} · ${vacantes(best.n)}` })),
      skillBar(scale, best),
      el("span", { class: "sk-num", text: moneyFull(best.median) }));
    const more = el("div", { class: "sk-more" }, el("p", { text: halfRange(best) + "." }),
      ...r.scopes.slice(1).map((s) => el("p", { class: "muted", text: `${SK_WHERE[s.group]}: mediana ${moneyFull(s.median)} · ${vacantes(s.n)}. ${halfRange(s)}.` })));
    const ref = SK.data.reference.bands.filter((b) => b.skill === r.id);
    if (ref.length) {
      const usd = SK.data.aggregate.fx.USD || 18.5;
      more.append(el("p", { class: "muted", text: `Referencia débil (Talently, fuentes internas, sin muestra): ${ref.map((b) => `${b.level === "sr" ? "senior" : "intermedio"} ${moneyFull(b.min_usd * usd)} a ${moneyFull(b.max_usd * usd)}`).join("; ")} al mes.` }));
    }
    return el("li", {}, el("details", { class: "sk-item" }, head, more));
  }));
  const few = summary.fewData;
  $("#skills-few").hidden = few.length === 0;
  $("#skills-few-summary").textContent = `Habilidades con pocos datos (${few.length})`;
  $("#skills-few-list").replaceChildren(...few.map((f) => el("li", {
    text: f.domain
      ? `${f.label}: es un área, no una habilidad técnica; no entra en tu ranking.`
      : f.n ? `${f.label}: solo ${vacantes(f.n)} (hacen falta 8).` : `${f.label}: ${f.relevant ? `${f.relevant} vacantes encontradas, ninguna con sueldo publicado.` : "sin vacantes con sueldo publicado."}`,
  })));
}

function renderSkillsTable(data) {
  const agg = data.aggregate;
  const t = $("#skills-table");
  t.replaceChildren(el("tr", {}, ...["Habilidad", "Dónde", "Vacantes con sueldo", "Paga la mitad inferior hasta", "Mediana", "Paga la mitad superior desde"].map((h) => el("th", { text: h }))));
  for (const row of [agg.combo, ...agg.skills]) {
    for (const g of Object.keys(SK_WHERE)) {
      const s = row.groups[g];
      const m = (v) => (v === null ? "—" : moneyFull(v));
      t.append(el("tr", {}, el("td", { text: row.id === "combo" ? "Python + otra de tus especialidades" : row.label }), el("td", { text: SK_WHERE[g] }), el("td", { text: String(s.n) }),
        ...(s.insufficient ? [el("td", { colspan: "3", class: "muted", text: s.n ? "Muy pocas vacantes para dar un rango" : "Sin datos" })] : [m(s.p25), m(s.median), m(s.p75)].map((v) => el("td", { text: v })))));
    }
  }
  const d = agg.discards;
  $("#skills-meta").textContent = `Tipo de cambio: ${Object.entries(agg.fx).filter(([k]) => k !== "MXN").map(([k, v]) => `${k} = $${v}`).join(", ")} (${agg.fx_source === "CLAUDE.md" ? "de tu perfil" : "valores por defecto"}). Portales: ${agg.portals.map(portalLabel).join(", ")}. ` +
    `Vacantes únicas: ${agg.totals.unique_jobs}; con la habilidad en título o etiquetas: ${agg.totals.relevant_jobs}; con sueldo usable: ${agg.totals.used_with_salary}. ` +
    `Descartadas: ${d.no_salary} sin sueldo, ${d.noise_low} por sueldo absurdamente bajo, ${d.noise_high} por absurdamente alto, ${d.unknown_currency} con moneda desconocida, ${d.no_period} sin periodo, ${d.unclassified} sin ubicación utilizable, ${d.irrelevant} sin relación con tus habilidades. Sueldos por hora se convierten ×160 horas al mes.`;
}

function renderSkills(data) {
  SK.data = data;
  const has = Boolean(data.aggregate);
  $("#skills-empty").hidden = has;
  $("#skills-body").hidden = !has;
  const date = $("#skills-date");
  if (!has) {
    date.textContent = "Sin datos todavía.";
    return;
  }
  const when = new Date(data.aggregate.generated_at);
  const days = Math.floor((Date.now() - when.getTime()) / 86400000);
  const ago = days <= 0 ? "hoy" : days === 1 ? "hace 1 día" : `hace ${days} días`;
  date.textContent = `Datos del ${when.toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" })} (${ago}).`;
  const sum = data.summary;
  $("#skills-lead").textContent = sum.lead || "Todavía no hay suficientes vacantes con sueldo publicado (mínimo 8 por habilidad) para estimar cuánto puedes ganar.";
  $("#skills-axis").hidden = $("#skills-list").hidden = sum.ranked.length === 0;
  renderSkillsRanked(sum);
  renderSkillsTable(data);
}

async function loadSkills() {
  try {
    renderSkills(await api("/api/skills"));
  } catch (err) {
    $("#skills-date").textContent = `No se pudieron cargar los datos: ${err.message}`;
  }
}

async function startMarketRefresh() {
  try {
    const { id } = await api("/api/market/refresh", {});
    showRunPanel("Actualizando datos de mercado — puede tardar unos minutos");
    followRun(id, () => loadSkills());
  } catch (err) {
    runError(err);
  }
}

// ---------- boot ----------
async function boot() {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => {
      for (const t of document.querySelectorAll(".tab")) {
        t.classList.toggle("active", t === tab);
        t.setAttribute("aria-selected", String(t === tab));
      }
      $("#tab-jobs").hidden = tab.dataset.tab !== "jobs";
      $("#tab-tracking").hidden = tab.dataset.tab !== "tracking";
      $("#tab-market").hidden = tab.dataset.tab !== "market";
      if (tab.dataset.tab === "tracking") refreshTracking();
      if (tab.dataset.tab === "market") {
        refreshMarket();
        loadSkills();
      }
    });
  }
  const openFromHash = () => {
    const t = { "#mercado": "market", "#seguimiento": "tracking" }[location.hash];
    if (t) document.querySelector(`.tab[data-tab="${t}"]`)?.click();
  };
  window.addEventListener("hashchange", openFromHash);
  $("#market-form").addEventListener("change", saveMarketSettings);
  $("#market-form").addEventListener("submit", (ev) => ev.preventDefault());
  window.addEventListener("resize", () => {
    clearTimeout(MK.resizeTimer);
    MK.resizeTimer = setTimeout(() => {
      if (MK.data && !$("#tab-market").hidden) renderMarketChart(MK.data);
    }, 120);
  });
  $("#skills-refresh").addEventListener("click", startMarketRefresh);
  openFromHash();
  $("#search-btn").addEventListener("click", startSearch);
  $("#rank-btn").addEventListener("click", startRank);
  $("#theme-btn").addEventListener("click", toggleTheme);
  $("#daily-switch").addEventListener("click", toggleDaily);
  refreshDaily();
  applyTheme(null);
  $("#run-close").addEventListener("click", () => ($("#run-panel").hidden = true));
  $("#review-close").addEventListener("click", () => $("#review").close());

  const stored = await api("/api/search-settings");
  savedFilters = filtersFromSettings(stored.search);
  fillFilterForm(savedFilters);
  renderCoverage(stored.lastSweep);
  renderJobs(await api(`/api/jobs?${filterQuery(savedFilters)}`));
  $("#filters").addEventListener("input", () => {
    saveFilters(readFilterForm());
    refreshJobs();
  });

  // Reattach to a run that was already going when the page loaded.
  const { run } = await api("/api/run");
  if (run && run.status === "running") {
    showRunPanel(run.label);
    followRun(run.id, () => refreshJobs());
  }
}

boot().catch((err) => {
  $("#jobs-summary").textContent = `No se pudo iniciar el panel: ${err.message}`;
});
