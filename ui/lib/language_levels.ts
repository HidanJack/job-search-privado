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
