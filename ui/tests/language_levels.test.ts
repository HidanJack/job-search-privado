import { describe, expect, test } from "bun:test";
import {
  atLeast, englishName, isUnspoken, languageCode, languageName, levelRank, parseLevel, reads, speakStatus, speaks,
  spokenGapLanguage, userLevels, type LanguageLevel,
} from "../lib/language_levels";

const A2_SPEAKER: LanguageLevel[] = [
  { language: "Spanish", read: "native", write: "native", speak: "native" },
  { language: "English", read: "B2", write: "B2", speak: "A2" },
];
const FRIEND: LanguageLevel[] = [
  { language: "Inglés", read: "C1", write: "C1", speak: "C1" },
  { language: "Alemán", read: "B2", write: "B2", speak: "B2" },
];

describe("CEFR and names", () => {
  test("order and parsing", () => {
    const ranks = ["A1", "A2", "B1", "B2", "C1", "C2", "native"].map(levelRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(parseLevel(" b2 ")).toBe("B2");
    expect(parseLevel("Nativo")).toBe("native");
    expect(parseLevel("fluent")).toBeNull();
    expect(levelRank(null)).toBe(0);
    expect(atLeast("C1", "B2")).toBe(true);
    expect(atLeast(null, "A1")).toBe(false);
  });

  test("names in several languages map to the same code as Python", () => {
    const cases: Record<string, string> = {
      "Alemán": "de", German: "de", Deutsch: "de", "Inglés": "en", English: "en", "Portugués": "pt", "Português": "pt",
      "Francés": "fr", Italiano: "it", "Neerlandés": "nl", Dutch: "nl", Nederlands: "nl", "Español": "es", "Japonés": "ja",
    };
    for (const [name, code] of Object.entries(cases)) expect(languageCode(name)).toBe(code);
    expect(languageCode("Klingon")).toBeNull();
    expect(languageName("de")).toBe("alemán");
    expect(englishName("de")).toBe("german");
  });
});

describe("user levels and the unspoken filter", () => {
  test("levels by code; Spanish assumed native; missing language has no level", () => {
    const lv = userLevels(FRIEND);
    expect(lv.es.speak).toBe("native");
    expect(lv.de.speak).toBe("B2");
    expect(speaks(lv, "fr", "A1")).toBe(false);
    expect(reads(lv, "de", "A2")).toBe(true);
  });

  test("no languages declared: the legacy A2-speaker default (English read B2, speak A2)", () => {
    const lv = userLevels([]);
    expect(lv.en).toEqual({ read: "B2", write: "B2", speak: "A2" });
    expect(speakStatus(lv, "en")).toBe("gap");
  });

  test("speak status thresholds", () => {
    const mid = userLevels([{ language: "German", read: "B1", write: "B1", speak: "B1" }]);
    expect(speakStatus(mid, "de")).toBe("borderline");
    expect(speakStatus(userLevels(FRIEND), "en")).toBe("comfortable");
  });

  test("A2 speaker: English (speak A2) is hidden, Spanish and mixed are not, German is", () => {
    const lv = userLevels(A2_SPEAKER);
    expect(isUnspoken("en", lv)).toBe(true);
    expect(isUnspoken("es", lv)).toBe(false);
    expect(isUnspoken("mixed", lv)).toBe(false);
    expect(isUnspoken(null, lv)).toBe(false);
    expect(isUnspoken("de", lv)).toBe(true);
  });

  test("friend: nothing hidden for English or German; French is", () => {
    const lv = userLevels(FRIEND);
    expect(isUnspoken("en", lv)).toBe(false);
    expect(isUnspoken("de", lv)).toBe(false);
    expect(isUnspoken("fr", lv)).toBe(true);
  });

  test("B1 speaker is not hidden (soft flag only)", () => {
    expect(isUnspoken("de", userLevels([{ language: "German", read: "B1", write: "B1", speak: "B1" }]))).toBe(false);
    expect(isUnspoken("de", userLevels([{ language: "German", read: "B1", write: "B1", speak: "A2" }]))).toBe(true);
  });

  test("spoken-gap wording in notes", () => {
    expect(spokenGapLanguage("Alemán hablado C1")).toBe("de");
    expect(spokenGapLanguage("Spoken English required")).toBe("en");
    expect(spokenGapLanguage("Exigen SQL")).toBeNull();
  });
});
