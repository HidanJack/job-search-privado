/**
 * Languages as first-class data (TypeScript mirror of tools/language_levels.py).
 *
 * CEFR ranking, language name -> ISO 639-1 code, the candidate's levels from
 * profile_config.json "languages", and the thresholds the UI filter uses:
 *   speak >= B2 comfortable, speak == B1 borderline, below/undeclared = gap,
 *   read >= A2 = can read. A language missing from the profile has NO level.
 * Spanish is assumed native when the profile does not declare it.
 */
export type Cefr = "A1" | "A2" | "B1" | "B2" | "C1" | "C2" | "native";
export interface LanguageLevel {
  language: string;
  code?: string;
  read: Cefr | null;
  write: Cefr | null;
  speak: Cefr | null;
}
export type Levels = Record<string, { read: Cefr | null; write: Cefr | null; speak: Cefr | null }>;

export const CEFR_ORDER: Cefr[] = ["A1", "A2", "B1", "B2", "C1", "C2", "native"];
export const SPEAK_COMFORTABLE: Cefr = "B2";
export const SPEAK_BORDERLINE: Cefr = "B1";
export const READ_MIN: Cefr = "A2";
export const DEFAULT_NATIVE = "es";

/** code -> [Spanish display name, English name, other names]; all matched folded. */
const LANGS: Record<string, [string, string, string[]]> = {
  es: ["español", "spanish", ["espanol", "castellano", "spanisch", "espagnol"]],
  en: ["inglés", "english", ["ingles", "englisch", "anglais"]],
  de: ["alemán", "german", ["aleman", "deutsch", "allemand"]],
  fr: ["francés", "french", ["frances", "francais", "franzosisch", "französisch"]],
  it: ["italiano", "italian", ["italienisch", "italien"]],
  pt: ["portugués", "portuguese", ["portugues", "portugiesisch", "portugais"]],
  nl: ["neerlandés", "dutch", ["neerlandes", "holandes", "nederlands", "niederlandisch", "niederländisch"]],
  sv: ["sueco", "swedish", ["svenska"]],
  da: ["danés", "danish", ["danes", "dansk"]],
  no: ["noruego", "norwegian", ["norsk"]],
  fi: ["finés", "finnish", ["fines", "suomi"]],
  pl: ["polaco", "polish", ["polski", "polnisch"]],
  cs: ["checo", "czech", []],
  ro: ["rumano", "romanian", []],
  ru: ["ruso", "russian", ["русский"]],
  uk: ["ucraniano", "ukrainian", []],
  el: ["griego", "greek", []],
  tr: ["turco", "turkish", ["turkce"]],
  he: ["hebreo", "hebrew", []],
  ar: ["árabe", "arabic", ["arabe"]],
  hi: ["hindi", "hindi", []],
  zh: ["chino", "chinese", ["mandarin", "mandarino", "中文"]],
  ja: ["japonés", "japanese", ["japones", "日本語"]],
  ko: ["coreano", "korean", ["한국어"]],
};

export const fold = (s: unknown): string =>
  String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

const NAME_TO_CODE = new Map<string, string>();
for (const [code, [es, en, others]] of Object.entries(LANGS)) {
  for (const n of [es, en, ...others, code]) if (!NAME_TO_CODE.has(fold(n))) NAME_TO_CODE.set(fold(n), code);
}

/** Codes of every language the tools can name (valid `posting_language` values besides "mixed"). */
export const KNOWN_CODES: string[] = Object.keys(LANGS);

export function parseLevel(v: unknown): Cefr | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (["native", "nativo", "nativa", "materna"].includes(t.toLowerCase())) return "native";
  const up = t.toUpperCase();
  return (CEFR_ORDER as string[]).includes(up) ? (up as Cefr) : null;
}
export const levelRank = (v: unknown): number => {
  const l = parseLevel(v);
  return l ? CEFR_ORDER.indexOf(l) + 1 : 0;
};
export const atLeast = (v: unknown, min: Cefr): boolean => levelRank(v) >= levelRank(min) && levelRank(v) > 0;

export function languageCode(name: unknown): string | null {
  if (typeof name !== "string" || !name.trim()) return null;
  return NAME_TO_CODE.get(fold(name)) ?? null;
}
/** Lowercase Spanish name ("alemán"); the code itself when unknown. */
export const languageName = (code: string): string => LANGS[code]?.[0] ?? code;
/** English name ("german") used in search queries; null when the code is unknown. */
export const englishName = (code: string): string | null => LANGS[code]?.[1] ?? null;

/** {code: {read, write, speak}} from the profile's languages; legacy default: es native + English B2/B2/A2. */
export function userLevels(languages: LanguageLevel[] | undefined | null): Levels {
  const out: Levels = {};
  for (const item of languages ?? []) {
    const code = item.code && /^[a-z]{2,3}$/.test(item.code) ? item.code : languageCode(item.language);
    if (!code) continue;
    const slot = (out[code] ??= { read: null, write: null, speak: null });
    for (const skill of ["read", "write", "speak"] as const) {
      const lvl = parseLevel(item[skill]);
      if (levelRank(lvl) > levelRank(slot[skill])) slot[skill] = lvl;
    }
  }
  if (Object.keys(out).length === 0) out.en = { read: "B2", write: "B2", speak: "A2" };
  if (!out[DEFAULT_NATIVE]) out[DEFAULT_NATIVE] = { read: "native", write: "native", speak: "native" };
  return out;
}

const level = (levels: Levels, code: string, skill: "read" | "write" | "speak") => levels[code]?.[skill] ?? null;
export const speaks = (levels: Levels, code: string, min: Cefr) => atLeast(level(levels, code, "speak"), min);
export const reads = (levels: Levels, code: string, min: Cefr) => atLeast(level(levels, code, "read"), min);

export type SpeakStatus = "comfortable" | "borderline" | "gap";
export function speakStatus(levels: Levels, code: string): SpeakStatus {
  if (speaks(levels, code, SPEAK_COMFORTABLE)) return "comfortable";
  if (speaks(levels, code, SPEAK_BORDERLINE)) return "borderline";
  return "gap";
}

/**
 * "Hide postings in languages I do not speak": a posting written in L (not mixed/unknown)
 * is hidden when the candidate's spoken level in L is below B1 (or undeclared).
 */
export function isUnspoken(postingLanguage: string | null, levels: Levels): boolean {
  if (!postingLanguage || postingLanguage === "mixed" || postingLanguage === "unknown") return false;
  return !speaks(levels, postingLanguage, SPEAK_BORDERLINE);
}

/** Spanish/English "spoken <language>" wording in a gate note: the language code it names, else null. */
export function spokenGapLanguage(text: string): string | null {
  const t = fold(text);
  for (const code of ["en", "de", "fr", "it", "pt", "nl", "es"]) {
    const [es, en] = LANGS[code];
    const e = fold(es), n = en;
    if (new RegExp(`${e}\\s+(?:hablado|fluido|conversacional)|spoken\\s+${n}|${n}[^.]{0,40}(?:interview|conversation|calls?)`).test(t)) return code;
  }
  return null;
}

// ---- the real requirement (mirror of language_levels.requirement_assessment) -----------------
export type ReqSkill = "speak" | "read_write" | "any";
export type ReqKind = "fluent" | "conversational" | "advanced" | "intermediate" | "basic" | "technical_read_write" | "unspecified";
export interface LanguageRequirement {
  lang: string;
  skill: ReqSkill;
  level: Cefr | null;
  kind: ReqKind;
  evidence: string | null;
  source: "llm" | "regex" | "none" | "llm_assumption";
  optional?: boolean;
}
/** spoken: explicit gap; read_write: covered; optional: a plus; unspecified: level not stated; none: nothing to assess. */
export type LanguageNeed = "spoken" | "read_write" | "optional" | "unspecified" | "none";
export interface LanguageAssessment {
  need: LanguageNeed;
  verdict: "PASS" | "FLAG";
  note: string | null;
  evidence: string | null;
  riskFactor: number;
  /** True when the posting was never analysed (no `language_requirements`): the old rule applies. */
  legacy: boolean;
}

const REQ_SKILLS: ReqSkill[] = ["speak", "read_write", "any"];
const REQ_KINDS: ReqKind[] = ["fluent", "conversational", "advanced", "intermediate", "basic", "technical_read_write", "unspecified"];
const IMPLIED_LEVEL: Record<string, Cefr> = { fluent: "C1", advanced: "C1", conversational: "B2", intermediate: "B1", basic: "A2" };
const KIND_WORD: Record<string, string> = {
  fluent: "fluido", conversational: "conversacional", advanced: "avanzado", intermediate: "intermedio", basic: "básico", technical_read_write: "técnico",
};
export const UNSPECIFIED_RISK_FACTOR = 0.5;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Defensive read of a stored `language_requirements`: null when it is not a list (never analysed). */
export function parseRequirements(raw: unknown): LanguageRequirement[] | null {
  if (!Array.isArray(raw)) return null;
  const out: LanguageRequirement[] = [];
  for (const item of raw.slice(0, 12)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.lang !== "string" || !KNOWN_CODES.includes(r.lang)) continue;
    const level = parseLevel(r.level);
    out.push({
      lang: r.lang,
      skill: REQ_SKILLS.includes(r.skill as ReqSkill) ? (r.skill as ReqSkill) : "any",
      level: level && level !== "native" ? level : null,
      kind: REQ_KINDS.includes(r.kind as ReqKind) ? (r.kind as ReqKind) : "unspecified",
      evidence: typeof r.evidence === "string" && r.evidence.trim() ? r.evidence.slice(0, 160) : null,
      source: r.source === "llm" || r.source === "none" || r.source === "llm_assumption" ? r.source : "regex",
      ...(r.optional === true ? { optional: true } : {}),
    });
  }
  return out;
}

function writtenLevel(levels: Levels, code: string): Cefr | null {
  const read = level(levels, code, "read"), write = level(levels, code, "write");
  if (read === null || write === null) return read ?? write;
  return levelRank(read) <= levelRank(write) ? read : write;
}

function classify(r: LanguageRequirement, levels: Levels, code: string): "optional" | "unspecified" | "covered" | "gap" {
  if (r.optional) return "optional";
  if (r.kind === "unspecified") return "unspecified";
  const wanted = r.level ?? IMPLIED_LEVEL[r.kind] ?? null;
  if (r.skill === "speak" || r.kind === "fluent" || r.kind === "conversational") {
    return wanted === null || levelRank(wanted) > levelRank(level(levels, code, "speak")) ? "gap" : "covered";
  }
  const have = writtenLevel(levels, code);
  if (wanted === null) return atLeast(have, READ_MIN) ? "covered" : "gap";
  return levelRank(wanted) > levelRank(have) ? "gap" : "covered";
}

export function requirementAssessment(postingLanguage: string | null, requirements: LanguageRequirement[] | null, levels: Levels): LanguageAssessment {
  const none: LanguageAssessment = { need: "none", verdict: "PASS", note: null, evidence: null, riskFactor: 1, legacy: false };
  const code = postingLanguage;
  if (!code || code === "mixed" || code === "unknown" || !KNOWN_CODES.includes(code)) return none;
  if (speakStatus(levels, code) === "comfortable") return none;
  const name = languageName(code);
  if (requirements === null) {
    // Old rule: a posting written in L implies spoken L unless the candidate speaks it at B1+ (see isUnspoken).
    const gap = isUnspoken(code, levels);
    return { ...none, need: gap ? "spoken" : "unspecified", verdict: gap ? "FLAG" : "PASS", legacy: true };
  }
  const groups = { gap: [] as LanguageRequirement[], covered: [] as LanguageRequirement[], optional: [] as LanguageRequirement[], unspecified: [] as LanguageRequirement[] };
  for (const r of requirements) if (r.lang === code) groups[classify(r, levels, code)].push(r);
  const speak = level(levels, code, "speak");
  if (groups.gap.length) {
    const r = groups.gap[0];
    const kw = KIND_WORD[r.kind] ?? "";
    const lvl = r.level ? ` (${r.level})` : "";
    let what = kw ? `${name} ${kw}${lvl}` : `${name}${lvl}`;
    let tail: string;
    if (r.skill === "read_write") {
      const w = writtenLevel(levels, code);
      tail = w ? `Tu nivel de lectura/escritura es ${w}.` : `No tienes ${name} declarado en tu perfil.`;
      what = `${name} de lectura/escritura${lvl}`;
    } else tail = speak === null ? `No tienes ${name} hablado declarado en tu perfil.` : `Tu nivel hablado es ${speak}.`;
    return { ...none, need: "spoken", verdict: "FLAG", evidence: r.evidence, riskFactor: 1,
      note: r.evidence ? `Piden ${what}: «${r.evidence}». ${tail}` : `Piden ${what}. ${tail}` };
  }
  if (groups.covered.length) {
    const r = groups.covered[0];
    return { ...none, need: "read_write", evidence: r.evidence, riskFactor: 0, note: `Piden ${name} de lectura/escritura (${r.level ?? writtenLevel(levels, code)}): lo cubres.` };
  }
  if (groups.optional.length) {
    return { ...none, need: "optional", evidence: groups.optional[0].evidence, riskFactor: 0, note: `${cap(name)} aparece como un plus, no como requisito.` };
  }
  const evidence = groups.unspecified.find((r) => r.evidence)?.evidence ?? null;
  return { ...none, need: "unspecified", verdict: "FLAG", evidence, riskFactor: UNSPECIFIED_RISK_FACTOR, note: `No especifica el nivel; probablemente hay reuniones en ${name}.` };
}
