// First-run screens: entry -> analysing (SSE) -> review/edit -> done.
// All text from the CV / proposal is untrusted: it is only ever set through textContent / .value.
import {
  LEVELS, MAX_TEXT, buildAnswers, canConfirm, describeApiError, errorsFor, flaggedLabels, foldEvent, formatBytes, fromDraft,
  getPath, isFlaggedWarning, levelLabel, newProgress, newRow, normPath, parseCurrentSalary, pathLabel, questionTarget, removeAt,
  setPath, toDraft, validateEntry,
} from "/onboarding-logic.js";

const $ = (sel, root = document) => root.querySelector(sel);
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c) node.append(c);
  return node;
}

async function request(path, { method = "GET", json, form } = {}) {
  const init = { method, headers: {} };
  if (json !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(json);
  }
  if (form) init.body = form;
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

const S = {
  step: null,
  file: null,
  payload: null, // FormData of the last analysis, for "Reintentar"
  progress: newProgress(),
  source: null,
  cancelPending: false,
  draft: null,
  flagged: [],
  repairs: [],
  details: null,
  dirty: false,
  busy: false,
  fields: [],
  rows: [],
  questions: [],
  result: null,
  proposalExtras: { warnings: [], questions: [] },
};

const SCREENS = ["input", "analyzing", "review", "done"];

// ---------- shell ----------
function setError(text) {
  const box = $("#onb-error");
  box.textContent = text || "";
  box.hidden = !text;
  if (text) box.scrollIntoView({ block: "nearest", behavior: reduceMotion() ? "auto" : "smooth" });
}

function show(step, { focus = true } = {}) {
  S.step = step;
  document.body.classList.add("onb-on");
  $("#onboarding").hidden = false;
  for (const s of SCREENS) $(`#onb-${s}`).hidden = s !== step;
  const at = SCREENS.indexOf(step);
  for (const li of document.querySelectorAll("#onb-steps li")) {
    const i = SCREENS.indexOf(li.dataset.step);
    li.classList.toggle("is-current", i === at);
    li.classList.toggle("is-past", i < at);
    if (i === at) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  }
  setError("");
  if (focus) {
    const title = $(`#onb-${step} .onb-title`);
    title.setAttribute("tabindex", "-1");
    title.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
}

function leave() {
  document.body.classList.remove("onb-on");
  $("#onboarding").hidden = true;
  window.scrollTo(0, 0);
  window.dispatchEvent(new CustomEvent("onboarding:done"));
}

function fieldError(id, text) {
  const e = $(id);
  e.textContent = text || "";
  e.hidden = !text;
}

// ---------- 1. entry ----------
function langRow(language = "", level = "B1") {
  const name = h("input", { type: "text", maxlength: "60", placeholder: "Alemán", "aria-label": "Idioma", autocomplete: "off", class: "onb-lang-name" });
  name.value = language;
  const sel = h("select", { "aria-label": "Nivel", class: "onb-lang-level" });
  for (const l of LEVELS) sel.append(h("option", { value: l, text: levelLabel(l) }));
  sel.value = level;
  const li = h("li", { class: "onb-lang" }, name, sel);
  li.append(h("button", {
    type: "button", class: "ghost small", text: "Quitar", "aria-label": "Quitar idioma",
    onclick: () => {
      const next = li.nextElementSibling?.querySelector("input") || li.previousElementSibling?.querySelector("input") || $("#onb-lang-add");
      li.remove();
      next.focus();
    },
  }));
  return li;
}

function readLangRows() {
  return [...document.querySelectorAll("#onb-langs .onb-lang")].map((li) => ({
    language: $(".onb-lang-name", li).value,
    level: $(".onb-lang-level", li).value,
  }));
}

function setFile(file) {
  S.file = file || null;
  $("#onb-file-name").textContent = file ? `${file.name} · ${formatBytes(file.size)}` : "Ninguno elegido";
  $("#onb-file-name").classList.toggle("muted", !file);
  $("#onb-file-clear").hidden = !file;
  if (!file) $("#onb-file").value = "";
}

function currentEntry() {
  return { fileName: S.file ? S.file.name : "", fileSize: S.file ? S.file.size : 0, text: $("#onb-text").value };
}

function buildForm() {
  const entry = currentEntry();
  const check = validateEntry(entry);
  for (const id of ["#onb-salary-err", "#onb-city-err", "#onb-langs-err"]) fieldError(id, "");
  if (!check.ok) return { error: check.error };
  const remote = document.querySelector('input[name="onb-remote"]:checked');
  const { answers, errors } = buildAnswers({
    salary: $("#onb-salary").value, city: $("#onb-city").value, remote: remote ? remote.value : "", languages: readLangRows(),
  });
  if (errors.length) {
    for (const e of errors) fieldError(`#onb-${e.field}-err`, e.message);
    $(`#onb-${errors[0].field === "languages" ? "lang-add" : errors[0].field}`).focus();
    return { error: "Revisa los datos marcados." };
  }
  const form = new FormData();
  if (S.file) form.append("file", S.file, S.file.name);
  if (entry.text.trim()) form.append("text", entry.text);
  form.append("answers", JSON.stringify(answers));
  return { form };
}

async function submitAnalysis(form) {
  S.busy = true;
  $("#onb-analyze").disabled = true;
  try {
    const { id } = await request("/api/onboarding/analyze", { method: "POST", form });
    S.payload = form;
    startFollowing(id);
  } catch (err) {
    setError(describeApiError(err));
    if (err.status === 409) refreshStatus().catch(() => {});
  } finally {
    S.busy = false;
    $("#onb-analyze").disabled = false;
  }
}

function initInput() {
  $("#onb-langs").append(langRow());
  $("#onb-lang-add").addEventListener("click", () => {
    if (document.querySelectorAll("#onb-langs .onb-lang").length >= 10) return fieldError("#onb-langs-err", "Máximo 10 idiomas.");
    const row = langRow("", "B1");
    $("#onb-langs").append(row);
    $("input", row).focus();
  });
  $("#onb-file").addEventListener("change", (ev) => {
    const f = ev.target.files[0];
    setFile(f);
    if (f) {
      const check = validateEntry({ fileName: f.name, fileSize: f.size, text: "x" });
      if (!check.ok) {
        setError(check.error);
        setFile(null);
      } else setError("");
    }
  });
  $("#onb-file-clear").addEventListener("click", () => {
    setFile(null);
    $("#onb-file").focus();
  });
  const drop = $("#onb-drop");
  drop.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    drop.classList.add("is-over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
  drop.addEventListener("drop", (ev) => {
    ev.preventDefault();
    drop.classList.remove("is-over");
    const f = ev.dataTransfer.files[0];
    if (!f) return;
    const check = validateEntry({ fileName: f.name, fileSize: f.size, text: "x" });
    if (!check.ok) return setError(check.error);
    const dt = new DataTransfer();
    dt.items.add(f);
    $("#onb-file").files = dt.files;
    setFile(f);
    setError("");
  });
  const count = $("#onb-text-count");
  $("#onb-text").addEventListener("input", (ev) => {
    const n = ev.target.value.length;
    count.textContent = `${n.toLocaleString("en-US")} / ${MAX_TEXT.toLocaleString("en-US")}`;
  });
  $("#onb-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const built = buildForm();
    if (built.error) return setError(built.error);
    setError("");
    submitAnalysis(built.form);
  });
}

// ---------- 2. analysing ----------
function paintProgress() {
  const p = S.progress;
  $("#onb-an-now").textContent = p.step || p.latest || "";
  const cost = $("#onb-an-cost");
  cost.textContent = p.cost;
  cost.hidden = !p.cost;
  const log = $("#onb-an-log");
  log.replaceChildren(...p.lines.map((l) => h("li", { class: l.type, text: l.text })));
  log.scrollTop = log.scrollHeight;
}

function analysingView(state) {
  const running = state === "running";
  $("#onb-spinner").hidden = !running;
  $("#onb-an-state").textContent = { running: "Trabajando…", failed: "El análisis no terminó", lost: "Se perdió la conexión" }[state] || "";
  $("#onb-an-fail").hidden = running;
  $("#onb-an-retry").hidden = running;
  const cancel = $("#onb-an-cancel");
  cancel.disabled = S.cancelPending;
  cancel.textContent = S.cancelPending ? "Cancelando al terminar…" : "Cancelar";
}

function startFollowing(id) {
  S.progress = newProgress();
  S.cancelPending = false;
  show("analyzing");
  analysingView("running");
  paintProgress();
  S.source?.close();
  const source = new EventSource(`/api/run/events?id=${encodeURIComponent(id)}`);
  S.source = source;
  source.onmessage = (msg) => {
    const e = JSON.parse(msg.data);
    if (e.type === "end") {
      source.close();
      onRunEnd(e.run);
      return;
    }
    S.progress = foldEvent(S.progress, e);
    paintProgress();
  };
  source.onerror = () => {
    source.close();
    analysingView("lost");
    $("#onb-an-fail-msg").textContent = "Se cortó la conexión con el panel. El análisis puede seguir corriendo: espera unos segundos y reintenta.";
    $("#onb-an-fail-list").replaceChildren();
  };
}

async function onRunEnd(run) {
  if (S.cancelPending) return discardAndRestart();
  if (run.status === "done") {
    try {
      await loadProposal();
      return;
    } catch (err) {
      return showFailure(describeApiError(err), err.data?.details);
    }
  }
  await showFailure(S.progress.lastError || "El análisis terminó con errores.");
}

async function showFailure(message, details) {
  analysingView("failed");
  $("#onb-an-fail-msg").textContent = message;
  let list = Array.isArray(details) ? details : null;
  if (!list) {
    try {
      list = (await request("/api/onboarding/status")).validation;
    } catch {}
  }
  $("#onb-an-fail-list").replaceChildren(...(list || []).map((e) => h("li", {}, h("strong", { text: `${pathLabel(e.path)}: ` }), e.message)));
  $("#onb-an-retry").focus();
}

async function discardAndRestart() {
  try {
    await request("/api/onboarding/cancel", { method: "POST", json: {} });
  } catch (err) {
    show("input");
    return setError(describeApiError(err));
  }
  S.cancelPending = false;
  show("input");
}

function initAnalysing() {
  $("#onb-an-cancel").addEventListener("click", async () => {
    const failed = !$("#onb-an-fail").hidden;
    if (failed) return discardAndRestart();
    S.cancelPending = true; // a running analysis cannot be stopped: its result is discarded when it ends
    analysingView("running");
    $("#onb-an-now").textContent = "El análisis ya está corriendo y no se puede detener; cuando termine, descartaré el resultado.";
  });
  $("#onb-an-retry").addEventListener("click", () => {
    if (S.payload) return submitAnalysis(S.payload);
    show("input");
  });
}

// ---------- 3. review ----------
let uid = 0;
const fid = (path) => `onb-f-${path.replace(/\./g, "-")}-${++uid}`;

function markDirty(on = true) {
  S.dirty = on;
  $("#onb-dirty").textContent = on ? "Cambios sin guardar" : "";
  refreshConfirm();
}

function control(path, { multiline, rows = 3, type = "text", inputmode, placeholder, list, maxlength } = {}) {
  const c = multiline ? h("textarea", { rows: String(rows) }) : h("input", { type });
  if (inputmode) c.setAttribute("inputmode", inputmode);
  if (placeholder) c.setAttribute("placeholder", placeholder);
  if (list) c.setAttribute("list", list);
  if (maxlength) c.setAttribute("maxlength", maxlength);
  c.value = getPath(S.draft, path) ?? "";
  c.addEventListener("input", () => {
    setPath(S.draft, path, c.value);
    markDirty();
  });
  return c;
}

/** A labelled field wired to a draft path; its error slot is filled by paintErrors(). */
function field(path, label, opts = {}) {
  const c = opts.select
    ? selectControl(path, opts.select)
    : control(path, opts);
  c.id = fid(path);
  const err = h("span", { class: "field-err", id: `${c.id}-err`, hidden: true });
  c.setAttribute("aria-describedby", err.id);
  S.fields.push({ path, control: c, err });
  return h("div", { class: `onb-field${opts.cls ? ` ${opts.cls}` : ""}` },
    h("label", { for: c.id, class: "field-label", text: label }),
    h("div", { class: opts.multiline ? "onb-area" : "onb-line" }, c),
    opts.hint ? h("span", { class: "field-hint muted", text: opts.hint }) : null,
    err);
}

function selectControl(path, options) {
  const sel = h("select");
  for (const [v, t] of options) sel.append(h("option", { value: v, text: t }));
  const cur = String(getPath(S.draft, path) ?? "");
  if (cur && !options.some(([v]) => v === cur)) sel.append(h("option", { value: cur, text: cur }));
  sel.value = cur;
  sel.addEventListener("change", () => {
    setPath(S.draft, path, sel.value);
    markDirty();
  });
  return sel;
}

const levelOptions = (blankLabel = "Sin dato") => [["", blankLabel], ...LEVELS.map((l) => [l, levelLabel(l)])];
const REMOTE_OPTIONS = [["", "Sin definir"], ["remote", "Remoto"], ["hybrid", "Híbrido"], ["onsite", "Presencial"], ["any", "Cualquiera"]];

const tag = (text, title) => h("span", { class: "onb-tag", text, title });
const inferredTag = (row) => (row.inferred ? tag("deducido", "No aparece en tu CV: lo deduje. Confirma o corrige.") : null);

function removeBtn(label, onclick) {
  return h("button", { type: "button", class: "ghost small onb-remove", text: "Quitar", "aria-label": label, onclick });
}

function structural(listPath, mutate, focusSel) {
  mutate();
  markDirty();
  renderReview({ focus: focusSel });
}

function rowBox(path, legend, extraTag, remove, ...children) {
  const err = h("span", { class: "field-err", hidden: true, role: "alert" });
  S.rows.push({ path, err });
  const box = h("fieldset", { class: "onb-item", "data-path": path },
    h("legend", {}, legend, extraTag ? [" ", extraTag] : null),
    ...children, err);
  box.prepend(remove);
  return box;
}

function addBtn(text, onclick) {
  return h("button", { type: "button", class: "ghost small onb-add", text: `+ ${text}`, onclick });
}

function sectionBox(title, hint, ...children) {
  return h("section", { class: "onb-sec" },
    h("h2", { class: "onb-h2", text: title }),
    hint ? h("p", { class: "muted onb-sec-hint", text: hint }) : null,
    ...children);
}

function highlightsEditor(i) {
  const path = `experience.${i}.highlights`;
  const wrap = h("div", { class: "onb-sub" }, h("p", { class: "field-label", text: "Logros" }));
  const err = h("span", { class: "field-err", hidden: true });
  S.fields.push({ path, control: wrap, err });
  const list = S.draft.experience[i].highlights;
  list.forEach((_, j) => {
    const area = control(`${path}.${j}`, { multiline: true, rows: 2 });
    area.setAttribute("aria-label", `Logro ${j + 1}`);
    wrap.append(h("div", { class: "onb-hl" }, area,
      removeBtn(`Quitar logro ${j + 1}`, () => structural(path, () => removeAt(S.draft, path, j), `[data-path="experience.${i}"] .onb-add`))));
  });
  wrap.append(err, addBtn("Agregar logro", () => structural(path, () => list.push(""), `[data-path="experience.${i}"] .onb-hl:last-of-type textarea`)));
  return wrap;
}

function renderReview({ focus } = {}) {
  S.fields = [];
  S.rows = [];
  uid = 0;
  const d = S.draft;
  const form = $("#onb-rev-form");
  const y = form.scrollTop;
  const frag = document.createDocumentFragment();

  frag.append(sectionBox("Identidad", null,
    h("div", { class: "onb-grid" },
      field("identity.name", "Nombre"),
      field("identity.email", "Correo", { type: "email", inputmode: "email" }),
      field("identity.phone", "Teléfono", { inputmode: "tel" }),
      field("identity.location", "Ubicación")),
    field("identity.links", "Enlaces", { multiline: true, rows: 2, hint: "Uno por línea (LinkedIn, GitHub, portafolio)." })));

  frag.append(sectionBox("Resumen", "Dos o tres líneas que te describan. Es la base del perfil de tus CV.",
    field("summary", "Resumen", { multiline: true, rows: 4 })));

  frag.append(sectionBox("Años de experiencia", "Los usa la calificación. Revisa que la cuenta tenga sentido.",
    h("div", { class: "onb-grid" },
      field("years_experience.value", "Años", { inputmode: "decimal", cls: "onb-narrow-field" }),
      field("years_experience.basis", "Cómo se calculó", { multiline: true, rows: 2, cls: "onb-span" }))));

  const exp = sectionBox("Experiencia", null);
  d.experience.forEach((e, i) => {
    const p = `experience.${i}`;
    exp.append(rowBox(p, `Experiencia ${i + 1}`, null,
      removeBtn(`Quitar experiencia ${i + 1}`, () => structural("experience", () => removeAt(S.draft, "experience", i), "#onb-exp-add")),
      h("div", { class: "onb-grid" },
        field(`${p}.company`, "Empresa"), field(`${p}.title`, "Puesto"),
        field(`${p}.start`, "Inicio", { placeholder: "2022-07" }), field(`${p}.end`, "Fin", { placeholder: "Actual" })),
      highlightsEditor(i)));
  });
  exp.append(addBtn("Agregar experiencia", () => structural("experience", () => d.experience.push(newRow("experience")), `[data-path="experience.${d.experience.length - 1}"] input`)));
  exp.lastChild.id = "onb-exp-add";
  frag.append(exp);

  const edu = sectionBox("Educación", null);
  d.education.forEach((e, i) => {
    const p = `education.${i}`;
    edu.append(rowBox(p, `Educación ${i + 1}`, null,
      removeBtn(`Quitar educación ${i + 1}`, () => structural("education", () => removeAt(S.draft, "education", i), "#onb-edu-add")),
      h("div", { class: "onb-grid" },
        field(`${p}.degree`, "Título"), field(`${p}.institution`, "Institución"),
        field(`${p}.status`, "Estado", { placeholder: "Concluida, trunca, en curso" }),
        field(`${p}.start`, "Inicio"), field(`${p}.end`, "Fin"))));
  });
  edu.append(addBtn("Agregar estudios", () => structural("education", () => d.education.push(newRow("education")), `[data-path="education.${d.education.length - 1}"] input`)));
  edu.lastChild.id = "onb-edu-add";
  frag.append(edu);

  const skills = sectionBox("Habilidades", "Lo marcado como deducido no aparece en tu CV: confírmalo o quítalo.");
  d.skills.forEach((s, i) => {
    const p = `skills.${i}`;
    skills.append(rowBox(p, `Habilidad ${i + 1}`, inferredTag(s),
      removeBtn(`Quitar habilidad ${i + 1}`, () => structural("skills", () => removeAt(S.draft, "skills", i), "#onb-skill-add")),
      h("div", { class: "onb-grid" },
        field(`${p}.name`, "Nombre"), field(`${p}.level`, "Nivel", { placeholder: "Experto, medio…" }),
        field(`${p}.evidence`, "Evidencia", { cls: "onb-span" }))));
  });
  skills.append(addBtn("Agregar habilidad", () => structural("skills", () => d.skills.push(newRow("skill")), `[data-path="skills.${d.skills.length - 1}"] input`)));
  skills.lastChild.id = "onb-skill-add";
  frag.append(skills);

  const langs = sectionBox("Idiomas", "Nivel de lectura, escritura y conversación (MCER, de A1 a C2, o nativo).");
  d.languages.forEach((l, i) => {
    const p = `languages.${i}`;
    langs.append(rowBox(p, `Idioma ${i + 1}`, inferredTag(l),
      removeBtn(`Quitar idioma ${i + 1}`, () => structural("languages", () => removeAt(S.draft, "languages", i), "#onb-lang-add2")),
      h("div", { class: "onb-grid onb-grid-4" },
        field(`${p}.language`, "Idioma"),
        field(`${p}.read`, "Lectura", { select: levelOptions() }),
        field(`${p}.write`, "Escritura", { select: levelOptions() }),
        field(`${p}.speak`, "Conversación", { select: levelOptions() }))));
  });
  langs.append(addBtn("Agregar idioma", () => structural("languages", () => d.languages.push(newRow("language")), `[data-path="languages.${d.languages.length - 1}"] input`)));
  langs.lastChild.id = "onb-lang-add2";
  frag.append(langs);

  frag.append(sectionBox("Objetivos", "Lo que buscas. Los puestos guían la búsqueda y el sueldo mínimo filtra las vacantes.",
    field("targets.roles", "Puestos que buscas", { multiline: true, rows: 3, hint: "Uno por línea." }),
    h("div", { class: "onb-grid" },
      field("targets.remote", "Modalidad", { select: REMOTE_OPTIONS }),
      field("targets.location", "Ciudad o región"),
      field("targets.salary_floor_mxn", "Sueldo mínimo (MXN al mes)", { inputmode: "numeric", placeholder: "45000" }))));

  const fam = sectionBox("Familias de búsqueda", "Cada familia es un tipo de puesto; sus consultas son las palabras que se buscan en los portales, con el idioma de cada una.");
  d.search_families.forEach((f, i) => {
    const p = `search_families.${i}`;
    const box = rowBox(p, `Familia ${i + 1}`, inferredTag(f),
      removeBtn(`Quitar familia ${i + 1}`, () => structural("search_families", () => removeAt(S.draft, "search_families", i), "#onb-fam-add")),
      field(`${p}.name`, "Nombre de la familia"));
    const qs = h("div", { class: "onb-sub" }, h("p", { class: "field-label", text: "Consultas" }));
    const qErr = h("span", { class: "field-err", hidden: true });
    S.fields.push({ path: `${p}.queries`, control: qs, err: qErr });
    f.queries.forEach((q, j) => {
      const qp = `${p}.queries.${j}`;
      const text = control(`${qp}.text`, { maxlength: "80" });
      text.setAttribute("aria-label", `Consulta ${j + 1}`);
      const lang = control(`${qp}.lang`, { list: "onb-langcodes", maxlength: "3" });
      lang.setAttribute("aria-label", `Idioma de la consulta ${j + 1}`);
      const e1 = h("span", { class: "field-err", hidden: true });
      S.fields.push({ path: `${qp}.text`, control: text, err: e1 });
      S.fields.push({ path: `${qp}.lang`, control: lang, err: e1 });
      qs.append(h("div", { class: "onb-q" },
        h("div", { class: "onb-q-text" }, text), h("div", { class: "onb-q-lang" }, lang),
        removeBtn(`Quitar consulta ${j + 1}`, () => structural(`${p}.queries`, () => removeAt(S.draft, `${p}.queries`, j), `[data-path="${p}"] .onb-add`)), e1));
    });
    qs.append(qErr, addBtn("Agregar consulta", () => structural(`${p}.queries`, () => f.queries.push(newRow("query")), `[data-path="${p}"] .onb-q:last-of-type input`)));
    box.insertBefore(qs, box.lastChild);
    fam.append(box);
  });
  fam.append(addBtn("Agregar familia", () => structural("search_families", () => d.search_families.push(newRow("family")), `[data-path="search_families.${d.search_families.length - 1}"] input`)));
  fam.lastChild.id = "onb-fam-add";
  fam.append(h("datalist", { id: "onb-langcodes" }, ...["es", "en", "de", "fr", "pt", "it"].map((c) => h("option", { value: c }))));
  frag.append(fam);

  frag.append(sectionBox("Stack", "Tecnologías separadas por comas.",
    field("stack.strong", "Fuerte (lo dominas)", { multiline: true, rows: 2 }),
    field("stack.secondary", "Secundario (lo has usado)", { multiline: true, rows: 2 }),
    field("stack.avoid", "Evitar (no quieres trabajar con esto)", { multiline: true, rows: 2 })));

  form.replaceChildren(frag);
  form.scrollTop = y;
  paintErrors();
  if (focus) $(focus, form)?.focus();
}

function paintErrors() {
  const details = S.details;
  const flaggedSet = S.flagged.map(normPath);
  const isFlagged = (path) => flaggedSet.some((f) => f === path || f.startsWith(path + ".") || path.startsWith(f + "."));
  for (const f of S.fields) {
    const errs = errorsFor(details, f.path).map((e) => e.message);
    if (isFlagged(f.path)) errs.push("Parece una instrucción dirigida a una IA. Edítalo o bórralo para poder confirmar.");
    f.err.textContent = errs.join(" ");
    f.err.hidden = errs.length === 0;
    if (f.control.tagName === "DIV") continue;
    if (errs.length) f.control.setAttribute("aria-invalid", "true");
    else f.control.removeAttribute("aria-invalid");
  }
  for (const r of S.rows) {
    const errs = (details || []).filter((e) => normPath(e.path) === r.path).map((e) => e.message);
    r.err.textContent = errs.join(" ");
    r.err.hidden = errs.length === 0;
  }
  const box = $("#onb-save-errors");
  box.replaceChildren();
  if (details && details.length) {
    box.append(h("p", { text: "No pude guardar porque hay datos por corregir:" }),
      h("ul", { class: "onb-errlist" }, ...details.map((e) => h("li", {}, h("strong", { text: `${pathLabel(e.path)}: ` }), e.message))));
  }
  box.hidden = !(details && details.length);
}

function renderNotes() {
  const warn = $("#onb-warnings");
  const warnings = S.proposalExtras.warnings;
  const questions = S.proposalExtras.questions;
  warn.replaceChildren();
  if (warnings.length) {
    warn.append(h("h2", { class: "onb-h2", text: "Avisos" }),
      h("ul", { class: "onb-warnlist" }, ...warnings.map((w) => h("li", { class: isFlaggedWarning(w) ? "is-flag" : "", text: w }))));
  }
  if (questions.length) {
    warn.append(h("h2", { class: "onb-h2", text: "Preguntas pendientes" }),
      h("p", { class: "muted onb-sec-hint", text: "Me faltaron estos datos. Si no tienen un campo propio, corrígelos en los campos de abajo." }),
      h("ul", { class: "onb-questions" }, ...questions.map((q) => {
        const target = questionTarget(q);
        return h("li", {},
          h("strong", { text: q.text }),
          q.why ? h("span", { class: "muted", text: ` ${q.why} ` }) : null,
          target === "current_salary" ? h("button", { type: "button", class: "ghost small", text: "Responder abajo", onclick: () => $("#onb-current").focus() }) : null);
      })));
  }
  warn.hidden = !(warnings.length || questions.length);
  const flagged = $("#onb-flagged");
  if (S.flagged.length) {
    flagged.replaceChildren(h("strong", { text: "No puedo confirmar todavía. " }),
      `Estos campos parecen instrucciones para una IA: ${flaggedLabels(S.flagged).join(", ")}. Edítalos o bórralos y guarda los cambios.`);
  }
  flagged.hidden = S.flagged.length === 0;
}

function refreshConfirm() {
  const ok = canConfirm({ flagged: S.flagged, busy: S.busy });
  $("#onb-confirm").disabled = !ok;
  $("#onb-save").disabled = S.busy;
  const why = $("#onb-confirm-why");
  const text = S.flagged.length ? "Hay campos marcados: edítalos y guarda los cambios para poder confirmar." : "";
  why.textContent = text;
  why.hidden = !text;
  $("#onb-confirm").setAttribute("aria-describedby", text ? "onb-confirm-why" : "");
}

function applyProposal(res, { keepDraft = false } = {}) {
  S.draft = keepDraft ? S.draft : toDraft(res.proposal);
  S.flagged = res.flagged || [];
  S.repairs = res.repairs || [];
  S.proposalExtras = { warnings: res.proposal.warnings || [], questions: res.proposal.questions || [] };
  S.details = null;
}

async function loadProposal() {
  const res = await request("/api/onboarding/proposal");
  applyProposal(res);
  markDirty(false);
  show("review");
  renderNotes();
  renderReview();
  refreshConfirm();
}

async function saveDraft() {
  S.busy = true;
  refreshConfirm();
  try {
    const res = await request("/api/onboarding/proposal", { method: "PUT", json: { proposal: fromDraft(S.draft) } });
    applyProposal(res);
    markDirty(false);
    renderNotes();
    renderReview();
    const n = S.repairs.length;
    $("#onb-dirty").textContent = n ? `Guardado. Ajusté ${n} ${n === 1 ? "detalle" : "detalles"} automáticamente.` : "Guardado.";
    setError("");
    return true;
  } catch (err) {
    if (err.status === 422 && Array.isArray(err.data?.details)) {
      S.details = err.data.details;
      paintErrors();
      setError("Hay datos por corregir. Los marqué en el formulario.");
      const first = S.fields.find((f) => errorsFor(S.details, f.path).length && f.control.tagName !== "DIV");
      first?.control.focus();
    } else setError(describeApiError(err));
    return false;
  } finally {
    S.busy = false;
    refreshConfirm();
  }
}

async function confirmProfile() {
  const cur = parseCurrentSalary($("#onb-current").value);
  fieldError("#onb-current-err", cur.error);
  if (cur.error) return $("#onb-current").focus();
  if (S.dirty && !(await saveDraft())) return;
  if (!canConfirm({ flagged: S.flagged, busy: false })) return;
  S.busy = true;
  refreshConfirm();
  try {
    const body = cur.value ? { current_salary_mxn: cur.value } : {};
    S.result = await request("/api/onboarding/confirm", { method: "POST", json: body });
    showDone();
  } catch (err) {
    if (err.status === 422 && Array.isArray(err.data?.details)) {
      S.details = err.data.details;
      paintErrors();
    }
    setError(describeApiError(err));
  } finally {
    S.busy = false;
    refreshConfirm();
  }
}

function initReview() {
  $("#onb-save").addEventListener("click", saveDraft);
  $("#onb-confirm").addEventListener("click", confirmProfile);
  let armed = null;
  const cancel = $("#onb-cancel");
  cancel.addEventListener("click", async () => {
    if (!armed) {
      cancel.textContent = "Sí, descartar todo";
      armed = setTimeout(() => {
        armed = null;
        cancel.textContent = "Cancelar";
      }, 5000);
      return;
    }
    clearTimeout(armed);
    armed = null;
    cancel.textContent = "Cancelar";
    try {
      await request("/api/onboarding/cancel", { method: "POST", json: {} });
      S.payload = null;
      show("input");
    } catch (err) {
      setError(describeApiError(err));
    }
  });
}

// ---------- 4. done ----------
function showDone() {
  const r = S.result;
  $("#onb-written").replaceChildren(...(r.written || []).map((w) => h("li", {}, h("code", { text: w.path }), h("span", { class: "muted", text: ` ${formatBytes(w.bytes)}` }))));
  const un = r.unchanged || [];
  if (un.length) $("#onb-written").append(...un.map((p) => h("li", {}, h("code", { text: p }), h("span", { class: "muted", text: " sin cambios" }))));
  const backups = r.backups || [];
  $("#onb-backups").replaceChildren(...backups.map((p) => h("li", {}, h("code", { text: p }))));
  $("#onb-backups-box").hidden = backups.length === 0;
  show("done");
}

function initDone() {
  $("#onb-go").addEventListener("click", leave);
  $("#onb-go-search").addEventListener("click", () => {
    leave();
    setTimeout(() => $("#search-btn")?.click(), 400);
  });
}

// ---------- boot ----------
async function refreshStatus() {
  const st = await request("/api/onboarding/status");
  if (st.step === "analyzing" && st.run) return startFollowing(st.run.id);
  if (st.step === "review") {
    try {
      return await loadProposal();
    } catch (err) {
      show("input");
      return setError(describeApiError(err));
    }
  }
  if (st.needed) show("input", { focus: false });
}

async function init() {
  initInput();
  initAnalysing();
  initReview();
  initDone();
  try {
    await refreshStatus();
  } catch {
    // No onboarding API (or it failed): leave the normal app alone.
  }
}

init();
