// Pure helpers for the Vacantes cards and the "Lista negra" panel (no DOM, no fetch): unit-tested from
// ui/tests/job_logic.test.ts. Posting-derived text is untrusted: callers only ever set it through textContent.

const LANG_NAMES = {
  es: "español", en: "inglés", de: "alemán", fr: "francés", it: "italiano", pt: "portugués", nl: "neerlandés",
  sv: "sueco", da: "danés", no: "noruego", fi: "finés", pl: "polaco", cs: "checo", ro: "rumano",
  ru: "ruso", uk: "ucraniano", el: "griego", tr: "turco", he: "hebreo", ar: "árabe", hi: "hindi", zh: "chino",
  ja: "japonés", ko: "coreano",
};
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Chips about the language the posting really asks for: [{text, cls, title}]. */
export function languageChips(job) {
  const lang = job.posting_language;
  const name = LANG_NAMES[lang] || lang;
  const note = job.language_note || "";
  if (job.language_need === "spoken" || (job.language_need == null && job.spoken_language)) {
    const code = job.spoken_language || lang;
    if (!code) return [];
    return [{ text: `${cap(LANG_NAMES[code] || code)} hablado`, cls: "chip warn", title: note }];
  }
  if (job.language_need === "unspecified" && lang) {
    return [{ text: `Nivel de ${name} no especificado`, cls: "chip", title: job.language_evidence ? `«${job.language_evidence}»` : note }];
  }
  if (job.language_need === "read_write") {
    return [{ text: "Solo lectura/escritura", cls: "chip", title: job.language_evidence ? `«${job.language_evidence}» ${note}`.trim() : note }];
  }
  return [];
}

/** The verbatim quote behind the language need, ready to show on the card; null when there is none. */
export function languageQuote(job) {
  const ev = job.language_evidence;
  if (typeof ev !== "string" || !ev.trim()) return null;
  return `«${ev.length > 160 ? ev.slice(0, 160) : ev}»`;
}

export function entryView(entry, matches) {
  const parts = [];
  if (entry.aliases && entry.aliases.length) parts.push(`Alias: ${entry.aliases.join(", ")}`);
  if (entry.reason) parts.push(entry.reason);
  parts.push(matches > 0 ? plural(matches, "vacante", "vacantes") : "Sin vacantes guardadas");
  return { title: entry.name, detail: parts.join(" · ") };
}

export function suggestionView(s) {
  const parts = [s.company, plural(s.count, "vacante", "vacantes")];
  if (typeof s.medianAgeDays === "number") parts.push(`mediana de ${Math.round(s.medianAgeDays)} días`);
  if (s.reposted > 0) parts.push(`${s.reposted} republicadas`);
  parts.push(s.why);
  return parts.join(" · ");
}

export const confirmBlockText = (company) =>
  `¿Bloquear a ${company}? Sus vacantes dejarán de aparecer en tu lista. No se borra nada: puedes quitarla de la lista negra cuando quieras.`;

export const blockErrorText = (body) => (body && typeof body.message === "string" && body.message ? body.message : "No se pudo actualizar la lista negra.");

// Classic scripts (app.js) reach these through one global; the module stays importable from tests.
if (typeof window !== "undefined") window.JobLogic = { languageChips, languageQuote, entryView, suggestionView, confirmBlockText, blockErrorText };
