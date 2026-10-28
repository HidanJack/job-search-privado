#!/usr/bin/env python3
"""Languages as first-class data: CEFR levels, language codes and the language gate.

Single source of truth for everything that depends on which languages the
candidate reads, writes and speaks (profile_config.json -> "languages"):

  * CEFR parsing and ranking: A1 < A2 < B1 < B2 < C1 < C2 < native.
  * language name -> ISO 639-1 code ("Alemán", "German", "Deutsch" -> "de").
  * user_levels(config) -> {code: {"read": .., "write": .., "speak": ..}}.
  * THRESHOLDS (the only place they live):
        speak >= SPEAK_COMFORTABLE (B2)  -> comfortable: the posting language is no gap
        speak == SPEAK_BORDERLINE  (B1)  -> borderline: soft flag
        speak below B1 or undeclared     -> gap
        read  >= READ_MIN          (A2)  -> the candidate can read that language
  * language_gate(posting_language, levels) -> (PASS|FLAG, Spanish note): a posting
    written in L implies spoken L is needed; "mixed" (bilingual) needs reading only.
  * language_advantage(text, levels, posting_language): languages the posting asks
    for that the candidate speaks at B2+ and that are not the posting's own language.

A language missing from the profile has NO level (not "A1"). Spanish is assumed
native when the profile does not declare it: this workspace is Spanish-first
and the onboarding asks for the languages "besides Spanish".
"""
import re
import unicodedata

CEFR = ("A1", "A2", "B1", "B2", "C1", "C2", "native")
_RANK = {lvl: i + 1 for i, lvl in enumerate(CEFR)}

SPEAK_COMFORTABLE = "B2"   # speaking at or above this: the language is not a gap
SPEAK_BORDERLINE = "B1"    # exactly this: soft flag; below (or undeclared): a gap
READ_MIN = "A2"            # reading at or above this: the candidate can read the language
ADVANTAGE_MIN = "B2"       # speaking at or above this: a language the posting asks for is an advantage
DEFAULT_NATIVE = "es"      # assumed native when the profile does not declare it

# code -> (Spanish display name, every name the language goes by, folded)
_LANGS = {
    "es": ("español", ("espanol", "castellano", "spanish", "spanisch", "espagnol")),
    "en": ("inglés", ("ingles", "english", "englisch", "anglais")),
    "de": ("alemán", ("aleman", "german", "deutsch", "allemand")),
    "fr": ("francés", ("frances", "french", "francais", "franzosisch", "französisch")),
    "it": ("italiano", ("italian", "italienisch", "italien")),
    "pt": ("portugués", ("portugues", "portuguese", "portugiesisch", "portugais")),
    "nl": ("neerlandés", ("neerlandes", "holandes", "dutch", "nederlands", "niederlandisch", "niederländisch")),
    "sv": ("sueco", ("sueco", "swedish", "svenska")),
    "da": ("danés", ("danes", "danish", "dansk")),
    "no": ("noruego", ("noruego", "norwegian", "norsk")),
    "fi": ("finés", ("fines", "finnish", "suomi")),
    "pl": ("polaco", ("polaco", "polish", "polski", "polnisch")),
    "cs": ("checo", ("checo", "czech")),
    "ro": ("rumano", ("rumano", "romanian")),
    "ru": ("ruso", ("ruso", "russian", "русский")),
    "uk": ("ucraniano", ("ucraniano", "ukrainian")),
    "el": ("griego", ("griego", "greek")),
    "tr": ("turco", ("turco", "turkish", "turkce")),
    "he": ("hebreo", ("hebreo", "hebrew")),
    "ar": ("árabe", ("arabe", "arabic")),
    "hi": ("hindi", ("hindi",)),
    "zh": ("chino", ("chino", "chinese", "mandarin", "mandarino", "中文")),
    "ja": ("japonés", ("japones", "japanese", "日本語")),
    "ko": ("coreano", ("coreano", "korean", "한국어")),
}


def _fold(text) -> str:
    s = unicodedata.normalize("NFKD", str(text or "")).casefold()
    return "".join(c for c in s if not unicodedata.combining(c)).strip()


_NAME_TO_CODE: dict[str, str] = {}
for _code, (_es, _names) in _LANGS.items():
    for _n in (_es, *_names, _code):
        _NAME_TO_CODE.setdefault(_fold(_n), _code)


# ---- CEFR --------------------------------------------------------------------
def parse_level(value) -> str | None:
    """Canonical CEFR level ("A1".."C2" or "native"), or None when not a level."""
    if not isinstance(value, str):
        return None
    t = value.strip()
    if t.casefold() in ("native", "nativo", "nativa", "materna"):
        return "native"
    t = t.upper()
    return t if t in _RANK else None


def level_rank(level) -> int:
    """1 (A1) .. 7 (native); 0 for a missing or unknown level."""
    return _RANK.get(parse_level(level) or "", 0)


def at_least(level, minimum: str) -> bool:
    return level_rank(level) >= level_rank(minimum) > 0


# ---- names and codes ------------------------------------------------------------
def language_code(name) -> str | None:
    """ISO 639-1 code for a language name in Spanish/English/German or its own name."""
    if not isinstance(name, str) or not name.strip():
        return None
    return _NAME_TO_CODE.get(_fold(name))


def known_codes() -> tuple:
    """ISO codes of every language the tools can name."""
    return tuple(_LANGS)


def language_name(code: str) -> str:
    """Lowercase Spanish name ("alemán"); the code itself when unknown."""
    return _LANGS[code][0] if code in _LANGS else code


def _cap(text: str) -> str:
    return text[:1].upper() + text[1:]


# ---- the candidate's levels -------------------------------------------------------
def user_levels(config) -> dict:
    """{code: {"read": lvl|None, "write": lvl|None, "speak": lvl|None}} from a profile config.

    Falls back to the legacy `spoken_english` flag when no languages are declared
    (English read/write B2, speak B2 when true, A2 otherwise). Duplicate
    declarations of one language keep the best level per skill.
    """
    config = config if isinstance(config, dict) else {}
    out: dict = {}
    declared = config.get("languages")
    for item in declared if isinstance(declared, list) else []:
        if not isinstance(item, dict):
            continue
        code = item.get("code") if isinstance(item.get("code"), str) and re.fullmatch(r"[a-z]{2,3}", item["code"]) else None
        code = code or language_code(item.get("language"))
        if not code:
            continue
        slot = out.setdefault(code, {"read": None, "write": None, "speak": None})
        for skill in ("read", "write", "speak"):
            lvl = parse_level(item.get(skill))
            if level_rank(lvl) > level_rank(slot[skill]):
                slot[skill] = lvl
    if not out and "en" not in out:
        out["en"] = {"read": "B2", "write": "B2", "speak": "B2" if config.get("spoken_english") is True else "A2"}
    if DEFAULT_NATIVE not in out:
        out[DEFAULT_NATIVE] = {"read": "native", "write": "native", "speak": "native"}
    return out


def _level(levels: dict, code: str, skill: str):
    return (levels.get(code) or {}).get(skill)


def speaks(levels: dict, code: str, min_level: str) -> bool:
    return at_least(_level(levels, code, "speak"), min_level)


def reads(levels: dict, code: str, min_level: str) -> bool:
    return at_least(_level(levels, code, "read"), min_level)


def speak_status(levels: dict, code: str) -> str:
    """"comfortable" (>= B2), "borderline" (B1) or "gap" (below B1 or undeclared)."""
    if speaks(levels, code, SPEAK_COMFORTABLE):
        return "comfortable"
    if speaks(levels, code, SPEAK_BORDERLINE):
        return "borderline"
    return "gap"


def readable_codes(levels: dict) -> set:
    """Languages the candidate can read (read >= READ_MIN)."""
    return {c for c in levels if reads(levels, c, READ_MIN)}


# ---- the language gate ---------------------------------------------------------------
ENGLISH_POSTING_NOTE = "La vacante está escrita en inglés: probablemente se requiere inglés hablado."


def language_gate(posting_language, levels: dict) -> tuple[str, str | None]:
    """(PASS|FLAG, Spanish note) for a posting written in `posting_language`.

    A posting in L implies spoken L is needed. "mixed" (bilingual) needs reading
    only, and an unknown language raises nothing. English keeps its historical
    note text when the candidate declares an English level; otherwise the note names
    the language and the candidate's spoken level (or its absence).
    """
    code = posting_language
    if not isinstance(code, str) or code in ("mixed", "unknown", ""):
        return "PASS", None
    status = speak_status(levels, code)
    if status == "comfortable":
        return "PASS", None
    level = _level(levels, code, "speak")
    if code == "en" and level is not None:
        return "FLAG", ENGLISH_POSTING_NOTE  # historical wording, kept for anyone who declares an English level
    name = language_name(code)
    head = f"La vacante está escrita en {name}: probablemente se requiere {name} hablado"
    if level is None:
        return "FLAG", f"{head} y no tienes {name} hablado declarado en tu perfil."
    if status == "borderline":
        return "FLAG", f"{head} y tu nivel hablado es {level} (justo)."
    return "FLAG", f"{head} y tu nivel hablado es {level}."


# ---- the real requirement ---------------------------------------------------------------
# Minimum level each requirement kind implies when the posting states no CEFR level.
IMPLIED_LEVEL = {"fluent": "C1", "advanced": "C1", "conversational": "B2", "intermediate": "B1", "basic": "A2"}
_KIND_WORD = {"fluent": "fluido", "conversational": "conversacional", "advanced": "avanzado",
              "intermediate": "intermedio", "basic": "básico", "technical_read_write": "técnico"}
UNSPECIFIED_RISK_FACTOR = 0.5   # an unspecified level in a posting written in L: half of today's spoken-gap points


def _written_level(levels: dict, code: str):
    """The candidate's reading/writing level in `code`: the lower of the two (None when either is undeclared)."""
    read, write = _level(levels, code, "read"), _level(levels, code, "write")
    if read is None or write is None:
        return read or write
    return read if level_rank(read) <= level_rank(write) else write


def _classify(r: dict, levels: dict, code: str) -> str:
    """"optional" | "unspecified" | "covered" | "gap" for one requirement record of language `code`."""
    if r.get("optional") is True:
        return "optional"
    kind, skill = r.get("kind"), r.get("skill")
    if kind == "unspecified":
        return "unspecified"
    wanted = parse_level(r.get("level")) or IMPLIED_LEVEL.get(kind)
    if skill == "speak" or kind in ("fluent", "conversational"):
        return "gap" if level_rank(wanted) > level_rank(_level(levels, code, "speak")) or wanted is None else "covered"
    have = _written_level(levels, code)
    if wanted is None:  # technical reading/writing with no level: reading ability is enough
        return "covered" if at_least(have, READ_MIN) else "gap"
    return "gap" if level_rank(wanted) > level_rank(have) else "covered"


def _quote(r: dict) -> str:
    return f" «{r['evidence']}»" if r.get("evidence") else ""


def requirement_assessment(posting_language, requirements, levels: dict) -> dict:
    """What a posting written in L REALLY asks of the candidate, from its `language_requirements`.

    Returns {"need": "spoken"|"read_write"|"optional"|"unspecified"|"none", "verdict": PASS|FLAG,
    "note": Spanish text|None, "evidence": quote|None, "risk_factor": 0..1, "legacy": bool}.

      spoken       an explicit requirement above the candidate's level -> FLAG, full spoken-gap risk
      read_write   only reading/writing/technical/intermediate within the candidate's level -> PASS, no risk
      optional     "plus / nice to have" -> PASS, no risk
      unspecified  nothing stated in a posting written in L -> soft FLAG, half the risk
      none         nothing to assess: spanish/mixed/unknown posting or a comfortable speaker

    `requirements` None means the posting was never analysed: the old rule (a posting in L implies
    spoken L) applies unchanged (legacy True). An empty list means "analysed, nothing found".
    """
    out = {"need": "none", "verdict": "PASS", "note": None, "evidence": None, "risk_factor": 1.0, "legacy": False}
    code = posting_language
    if not isinstance(code, str) or code in ("mixed", "unknown", "") or code not in _LANGS:
        return out
    if speak_status(levels, code) == "comfortable":
        return out
    name = language_name(code)
    if requirements is None:
        verdict, note = language_gate(code, levels)
        return {**out, "need": "unspecified", "verdict": verdict, "note": note, "legacy": True}
    mine = [r for r in requirements if isinstance(r, dict) and r.get("lang") == code]
    sorted_by = {"gap": [], "covered": [], "optional": [], "unspecified": []}
    for r in mine:
        sorted_by[_classify(r, levels, code)].append(r)
    speak = _level(levels, code, "speak")
    if sorted_by["gap"]:
        r = sorted_by["gap"][0]
        kw = _KIND_WORD.get(r.get("kind"), "")
        lvl = f" ({r['level']})" if r.get("level") else ""
        what = f"{name} {kw}".strip() + lvl if kw else f"{name}{lvl}"
        if r.get("skill") == "read_write":
            tail = f"Tu nivel de lectura/escritura es {_written_level(levels, code)}." if _written_level(levels, code) else f"No tienes {name} declarado en tu perfil."
            what = f"{name} de lectura/escritura{lvl}"
        elif speak is None:
            tail = f"No tienes {name} hablado declarado en tu perfil."
        else:
            tail = f"Tu nivel hablado es {speak}."
        return {**out, "need": "spoken", "verdict": "FLAG", "evidence": r.get("evidence"),
                "note": f"Piden {what}:{_quote(r)}. {tail}" if r.get("evidence") else f"Piden {what}. {tail}", "risk_factor": 1.0}
    if sorted_by["covered"]:
        r = sorted_by["covered"][0]
        lvl = r.get("level") or _written_level(levels, code)
        return {**out, "need": "read_write", "evidence": r.get("evidence"), "risk_factor": 0.0,
                "note": f"Piden {name} de lectura/escritura ({lvl}): lo cubres."}
    if sorted_by["optional"]:
        r = sorted_by["optional"][0]
        return {**out, "need": "optional", "evidence": r.get("evidence"), "risk_factor": 0.0,
                "note": f"{_cap(name)} aparece como un plus, no como requisito."}
    evidence = next((r.get("evidence") for r in sorted_by["unspecified"] if r.get("evidence")), None)
    return {**out, "need": "unspecified", "verdict": "FLAG", "evidence": evidence, "risk_factor": UNSPECIFIED_RISK_FACTOR,
            "note": f"No especifica el nivel; probablemente hay reuniones en {name}."}


def gap_label(code: str) -> str:
    """Spanish gap text for a missing spoken language ("Inglés hablado")."""
    return f"{_cap(language_name(code))} hablado"


# English name of the languages the gap/advantage wording covers.
_EN_NAME = {"es": "spanish", "en": "english", "de": "german", "fr": "french", "it": "italian", "pt": "portuguese", "nl": "dutch"}


def gap_markers(code: str) -> tuple[str, ...]:
    """Lowercase fragments that mean "this gap already names spoken L" (old and new wording)."""
    spoken = (f"spoken {_EN_NAME[code]}",) if code in _EN_NAME else ()
    return (*spoken, f"{language_name(code)} hablado")


def _gap_patterns() -> dict:
    """Spoken-language gap wording in the fit analysis, matched on folded text:
    "<es-name> hablado|fluido|conversacional", "spoken <en-name>", "<en-name> ... interview|conversation|calls"."""
    out = {}
    for code, en_name in _EN_NAME.items():
        es_name = _fold(language_name(code))
        out[code] = re.compile(
            rf"{es_name}\s+(?:hablado|fluido|conversacional)"
            rf"|spoken\s+{en_name}"
            rf"|{en_name}[^.]{{0,40}}(?:interview|conversation|calls?)",
            re.I,
        )
    return out


_GAP_RX = _gap_patterns()


def stated_gap_language(text) -> str | None:
    """Code of the spoken language a gap/note names ("Alemán hablado C1" -> "de"), else None."""
    folded = _fold(text)
    for code, rx_ in _GAP_RX.items():
        if rx_.search(folded):
            return code
    return None


# ---- language advantage ----------------------------------------------------------------
_ADV_NAMES = {c: sorted({_fold(n) for n in (_LANGS[c][0], *_LANGS[c][1])}, key=len, reverse=True) for c in _EN_NAME}
_AFTER = r"(?:speaking|speaker|speakers|fluent|fluency|native|proficiency|proficient|skills?|language|kenntnisse|sprachkenntnisse|sprachig|sprachige|hablante|avanzado|avanzada|fluido|fluida|nativo|nativa|bilingue|c1|c2|b2)"
_BEFORE = r"(?:fluent|native|bilingual|bilingue|speak|speaking|fluency\s+in|proficiency\s+in|proficient\s+in|dominio\s+de|hablar|habla|conocimiento\s+de|excellent|advanced|business|verhandlungssicher)"
# Names that signal the language on their own (the native-language word or a region).
_STANDALONE = {"de": r"deutsch|deutschsprachig\w*|dach", "fr": r"francais|francophone", "nl": r"nederlands|nederlandstalig",
               "it": r"italiano", "pt": r"portugues|brasileiro"}


def _adv_patterns() -> dict:
    out = {}
    for code, names in _ADV_NAMES.items():
        alt = "|".join(re.escape(n) for n in names)
        parts = [rf"\b(?:{alt})[\s-]*{_AFTER}\b", rf"\b{_BEFORE}[\s/,&-]+(?:\w+[\s/,&-]+){{0,2}}?(?:{alt})\b"]
        if code in _STANDALONE:
            parts.append(rf"\b(?:{_STANDALONE[code]})\b")
        out[code] = re.compile("|".join(parts), re.I)
    return out


_ADV_RX = _adv_patterns()


def language_advantage(text, levels: dict, posting_language=None) -> list[str]:
    """Codes of languages the text asks for that the candidate speaks at B2+.

    Excluded: the posting's own language (it is the language of work, the gate
    already covers it) and the candidate's native languages.
    """
    folded = _fold(text)
    if not folded:
        return []
    found = []
    for code, rx_ in _ADV_RX.items():
        if code == posting_language or not speaks(levels, code, ADVANTAGE_MIN):
            continue
        if _level(levels, code, "speak") == "native":
            continue
        if rx_.search(folded):
            found.append(code)
    return found


def advantage_note(codes) -> str | None:
    names = [language_name(c) for c in codes]
    if not names:
        return None
    if len(names) == 1:
        listing, verb = names[0], "lo hablas"
    else:
        listing, verb = ", ".join(names[:-1]) + f" y {names[-1]}", "los hablas"
    return f"Ventaja de idioma: piden {listing} y tú {verb}."
