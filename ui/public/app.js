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

const FILTER_KEY = "job-ui-filters-v1";
const MODALITY_LABEL = { remote: "Remoto", hybrid: "Híbrido", onsite: "Presencial", unknown: "Modalidad sin especificar" };
const STATUS_LABEL = {
  drafted: "Borrador", applied: "Enviada", interview: "Entrevista", offer: "Oferta", hired: "Contratado",
  rejected: "Rechazada", no_response: "Sin respuesta", offer_declined: "Oferta rechazada", withdrawn: "Retirada",
};
const mxn = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });

let state = { profile: null, results: {}, jobs: [] };

// ---------- filters (persisted per browser; storage may be unavailable) ----------
function loadSavedFilters() {
  try {
    return JSON.parse(localStorage.getItem(FILTER_KEY) || "null");
  } catch {
    return null;
  }
}
function saveFilters(f) {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(f));
  } catch {
    /* private mode: filters just won't persist */
  }
}
function readFilterForm() {
  const form = $("#filters");
  return {
    maxDays: form.maxDays.value,
    minSalary: form.minSalary.value,
    includeNoSalary: form.includeNoSalary.checked,
    includeUndated: form.includeUndated.checked,
    modality: [...form.querySelectorAll("input[name=modality]:checked")].map((i) => i.value),
  };
}
function fillFilterForm(f) {
  const form = $("#filters");
  form.maxDays.value = f.maxDays;
  form.minSalary.value = f.minSalary;
  form.includeNoSalary.checked = f.includeNoSalary;
  form.includeUndated.checked = f.includeUndated;
  for (const i of form.querySelectorAll("input[name=modality]")) i.checked = f.modality.includes(i.value);
}
function filterQuery(f) {
  const p = new URLSearchParams();
  if (f) {
    if (f.maxDays !== "") p.set("maxDays", f.maxDays);
    if (f.minSalary !== "") p.set("minSalary", f.minSalary);
    p.set("includeNoSalary", f.includeNoSalary ? "1" : "0");
    p.set("includeUndated", f.includeUndated ? "1" : "0");
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
function fillList(ul, items, empty, iconName) {
  ul.replaceChildren(...(items.length ? items : [empty]).map((t) => {
    const li = el("li");
    if (iconName) li.append(icon(iconName));
    li.append(el("span", { text: t }));
    return li;
  }));
}

function emptyState() {
  const art = el("div", { class: "empty-art" }, icon("search"));
  const btn = el("button", { type: "button", class: "primary" }, icon("search"), el("span", { text: "Buscar ahora" }));
  btn.addEventListener("click", startSearch);
  return el("div", { class: "empty" },
    art,
    el("h3", { text: "Nada por aquí con estos filtros" }),
    el("p", { text: "Prueba subir los días de publicación o bajar el sueldo mínimo. Si ya los ajustaste, busca vacantes nuevas: tarda unos minutos." }),
    btn);
}

function renderJobs(data) {
  state.profile = data.profile;
  state.results = data.results || {};
  state.jobs = data.ranked.concat(data.unranked);
  $("#profile-banner").hidden = data.profile.ready;
  const box = $("#jobs");
  box.replaceChildren();
  box.setAttribute("aria-busy", "false");
  const tpl = $("#card-tpl");
  const rings = [];
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
    score.classList.add(!hasScore ? "is-empty" : j.rank_score >= 75 ? "high" : j.rank_score >= 60 ? "mid" : "low");
    if (hasScore) rings.push([score, Math.max(0, Math.min(100, j.rank_score))]);
    const meta = $(".meta", card);
    if (j.age_days !== null && j.age_days <= data.profile.freshnessDays) meta.append(el("span", { class: "chip new", text: "Nueva" }));
    meta.append(
      el("span", { class: "chip", text: MODALITY_LABEL[j.modality] }),
      el("span", { class: "chip", text: ageLabel(j.age_days) }),
      el("span", { class: "chip", text: j.portal || "portal desconocido" }),
    );
    if (j.rank_verdict) meta.append(el("span", { class: "chip verdict", text: j.rank_verdict }));
    const salary = $(".salary", card);
    salary.textContent = salaryLabel(j);
    salary.classList.toggle("unknown", j.salary_mxn_month === null);
    fillList($(".reasons", card), j.fit_reasons.length ? j.fit_reasons : j.strengths, "Sin detalle; vuelve a calificar con Buscar ahora.", "check");
    fillList($(".gaps", card), j.gaps, "Nada importante.", "gap");
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
  if (!data.ranked.length) box.append(emptyState());
  // Fill the rings after paint so the conic gradient sweeps in from zero.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    for (const [ring, value] of rings) ring.style.setProperty("--score", String(value));
  }));
  const f = data.filters;
  $("#jobs-summary").textContent = data.ranked.length
    ? `${data.ranked.length} ${data.ranked.length === 1 ? "vacante cumple" : "vacantes cumplen"} tus filtros (máx. ${f.maxDays} días, desde ${mxn.format(f.minSalaryMxn)} al mes), ordenadas por prioridad.`
    : "";

  const ul = $("#unranked");
  ul.replaceChildren(...data.unranked.map((j) => {
    const li = el("li");
    const a = el("a", { text: `${j.title} — ${j.company}`, target: "_blank", rel: "noopener noreferrer" });
    if (j.url) a.href = j.url;
    li.append(a, document.createTextNode(` (${ageLabel(j.age_days)})`));
    return li;
  }));
  $("#unranked-summary").textContent = `Vacantes sin calificar (${data.unranked.length})`;
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
  $("#search-btn").disabled = true;
  for (const b of document.querySelectorAll(".apply-btn")) b.disabled = true;
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
      $("#search-btn").disabled = false;
      onEnd(e.run);
      return;
    }
    log.append(el("li", { class: e.type, text: e.text }));
    log.scrollTop = log.scrollHeight;
  };
  source.onerror = () => {
    source.close();
    setRunStatus("se perdió la conexión", "err");
    $("#run-close").hidden = false;
    $("#search-btn").disabled = false;
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

async function startSearch() {
  try {
    const { id } = await api("/api/run/search", {});
    showRunPanel("Buscando y calificando vacantes — puede tardar varios minutos");
    followRun(id, () => refreshJobs());
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
  rateTable($("#by-portal"), data.byPortal, "Portal");
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

// ---------- boot ----------
async function boot() {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => {
      for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t === tab);
      $("#tab-jobs").hidden = tab.dataset.tab !== "jobs";
      $("#tab-tracking").hidden = tab.dataset.tab !== "tracking";
      if (tab.dataset.tab === "tracking") refreshTracking();
    });
  }
  $("#search-btn").addEventListener("click", startSearch);
  $("#theme-btn").addEventListener("click", toggleTheme);
  applyTheme(null);
  $("#run-close").addEventListener("click", () => ($("#run-panel").hidden = true));
  $("#review-close").addEventListener("click", () => $("#review").close());

  const first = await api(`/api/jobs?${filterQuery(loadSavedFilters())}`);
  const f = first.filters;
  fillFilterForm(loadSavedFilters() || {
    maxDays: f.maxDays, minSalary: f.minSalaryMxn, includeNoSalary: f.includeNoSalary,
    includeUndated: f.includeUndated, modality: f.modalities,
  });
  renderJobs(first);
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
