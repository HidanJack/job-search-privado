#!/usr/bin/env python3
"""Deterministic reader of the REAL language requirement of a posting.

A posting WRITTEN in English does not mean it needs SPOKEN English. This reads
what the text actually asks for and returns structured requirements:

  {"lang": "en", "skill": "speak"|"read_write"|"any", "level": "B2"|None,
   "kind": "fluent"|"conversational"|"advanced"|"intermediate"|"basic"
           |"technical_read_write"|"unspecified",
   "evidence": "verbatim quote (<= 160 chars)"|None, "source": "regex"|"llm"|"none",
   "optional": true   # only when the text calls it a plus / nice to have}

English and Spanish phrasings are covered by hand; any language language_levels
can name (German, French...) works with the generic patterns. When a posting
written in L says nothing about L, the result is one "unspecified" record for L
(a Spanish/mixed/unknown posting returns nothing).

Usage:
  python3 tools/language_requirement.py extract --text "..." [--posting-language en]
  python3 tools/language_requirement.py backfill [--write] [--state PATH]
"""
import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import language_levels  # noqa: E402

MAX_ITEMS = 6
MAX_EVIDENCE = 160
SKILLS = ("speak", "read_write", "any")
KINDS = ("fluent", "conversational", "advanced", "intermediate", "basic", "technical_read_write", "unspecified")
SOURCES = ("llm", "regex", "none", "llm_assumption")  # llm_assumption: an earlier analysis only ASSUMED spoken English
_CEFR = ("A1", "A2", "B1", "B2", "C1", "C2")
_KIND_RANK = {k: i for i, k in enumerate(("fluent", "advanced", "conversational", "intermediate", "technical_read_write", "basic", "unspecified"))}


def _fold_map(text: str) -> tuple[str, list[int]]:
    """Accent-free lowercase copy of `text` plus, per output char, its index in `text`."""
    out, idx = [], []
    for i, ch in enumerate(text):
        for c in unicodedata.normalize("NFKD", ch):
            if unicodedata.combining(c):
                continue
            for lc in c.casefold():
                out.append(lc)
                idx.append(i)
    return "".join(out), idx


# ---- language names ----------------------------------------------------------------
def _names() -> dict:
    """folded name -> code for every language the tools can name (codes and short names excluded)."""
    out = {}
    for code in language_levels.known_codes():
        spec = language_levels._LANGS[code]
        for n in (spec[0], *spec[1]):
            f = language_levels._fold(n)
            if len(f) >= 4 and f.isascii():
                out.setdefault(f, code)
    # "Deutsch"/"Englisch" style names are already in _LANGS; "mandarin" etc. too.
    return out


_NAME_CODE = _names()
LN = "(?:" + "|".join(sorted((re.escape(n) for n in _NAME_CODE), key=len, reverse=True)) + ")"
# Other language names (and "and"/"y"/commas) may precede L: "fluent in English and German".
LP = rf"(?:{LN}\W+(?:(?:and|or|y|e|o|und|et)\W+)?)*"
OPTIONAL = re.compile(
    r"\b(?:plus|nice[- ]to[- ]have|bonus|desirable|deseable|valorable|se valora|valued|preferred|preferible|"
    r"es un plus|deseado|would be (?:a )?(?:plus|nice|great)|ideal)\b")
SEGMENT = re.compile(r"[^\n.;!?•·▪●*]+(?:\.(?=\w)[^\n.;!?•·▪●*]*)*")

# (regex template with {L} = language name, kind, skill, level, applies-to-others)
_T: list[tuple[str, str, str, str | None]] = [
    # explicit spoken / fluent
    (r"\bfluen(?:t|cy)\W+(?:in\W+|with\W+)?{LP}{L}", "fluent", "speak", None),
    (r"\bnative[- ](?:level|speaker)\W+(?:of\W+|in\W+)?{LP}{L}|\b{L}\W+native\b", "fluent", "speak", None),
    (r"\b{L}\W{0,3}fluen(?:t|cy)\b|\b{L}\W+fluido\b|\bfluido\W+(?:en\W+)?{L}|\bbilingu(?:e|al)\W+(?:in\W+)?{L}|\b{L}\W+bilingu(?:e|al)\b|\bverhandlungssicher\w*\W+{L}", "fluent", "speak", None),
    (r"\bconversational\W+(?:level\W+)?(?:in\W+)?{LP}{L}|\b{L}\W+(?:conversational|conversacional)\b|\bconversacional\W+(?:de\W+|en\W+)?{L}", "conversational", "speak", None),
    (r"\bspoken\W+{L}|\b{L}\W+(?:speaking|hablado|oral)\b|\bspeak(?:ing)?\W+(?:fluent\W+|good\W+)?{LP}{L}|\bhabl(?:ar|a|ado)\W+(?:el\W+)?{L}|\b{L}\W+speaker", "conversational", "speak", None),
    (r"\b(?:excellent|strong|exceptional|outstanding|superb|advanced|proficient|professional)\W+(?:written\W+(?:and|&)\W+(?:verbal|oral|spoken)\W+|verbal\W+(?:and|&)\W+written\W+|oral\W+(?:and|&)\W+written\W+)?(?:communication|speaking)\W+(?:skills?\W+)?(?:in\W+|of\W+)?{LP}{L}", "advanced", "speak", None),
    (r"\b(?:good|solid|effective|clear|working)\W+(?:written\W+(?:and|&)\W+(?:verbal|oral|spoken)\W+|verbal\W+(?:and|&)\W+written\W+)?(?:communication|speaking)\W+(?:skills?\W+)?(?:in\W+|of\W+)?{LP}{L}", "conversational", "speak", None),
    (r"\b(?:interviews?|meetings?|stand-?ups?|calls?|demos?|presentations?|syncs?|ceremonies|entrevistas?|reuniones|juntas)\W+(?:\w+\W+){0,3}?(?:in|held in|conducted in|en)\W+{L}", "conversational", "speak", None),
    (r"\b{L}[- ]speaking\W+(?:team|teams|clients?|customers?|stakeholders?|environment|market|countries)", "conversational", "speak", None),
    (r"\bcomunicacion\W+(?:oral\W+)?(?:\w+\W+){0,2}?(?:en|de)\W+{L}", "conversational", "speak", None),
    # read / write
    (r"\b(?:read(?:ing)?|lectura|leer)\W+(?:and|&|y|/|,)\W+(?:writ(?:e|ing)|escritura|escribir)\W+(?:(?:technical|tecnico|business)\W+)?(?:de\W+|en\W+)?{L}|\b(?:read(?:ing)?|writ(?:e|ing))\W+(?:(?:and|&|/)\W+(?:read(?:ing)?|writ(?:e|ing))\W+)?(?:technical\W+)?(?:documentation\W+(?:in\W+)?)?{L}|\bwritten\W+{L}|\b{L}\W+(?:written|writing|documentation|reading)\b|\bdocumentacion\W+(?:tecnica\W+)?(?:en\W+)?{L}", "technical_read_write", "read_write", None),
    (r"\btechnical\W+{L}|\b{L}\W+(?:tecnico|technical)\b|\bingles\W+tecnico", "technical_read_write", "read_write", None),
    (r"\bcommunicat\w*\W+(?:\w+\W+){0,3}?(?:in|with)\W+{LP}{L}|\bcomunicarte?\W+(?:\w+\W+){0,3}?en\W+{L}|\b(?:converse|talk)\W+(?:\w+\W+){0,2}?in\W+{L}", "conversational", "speak", None),
    # levels by name
    (r"\bupper[- ]?intermediate\W+(?:level\W+)?(?:of\W+)?{L}|\b{L}\W+upper[- ]?intermediate", "intermediate", "any", "B2"),
    (r"\badvanced\W+(?:level\W+)?(?:of\W+)?{L}|\b{L}\W+(?:level\W+)?(?:advanced|avanzado|avanzada)\b|\b(?:nivel\W+)?avanzado\W+(?:de\W+|en\W+)?{L}|\bdominio\W+(?:avanzado\W+)?(?:del?\W+)?{L}", "advanced", "any", None),
    (r"\bintermediate\W+(?:level\W+)?(?:of\W+)?{L}|\b{L}\W+(?:level\W+)?(?:intermediate|intermedio|intermedia)\b|\b(?:nivel\W+)?intermedio\W+(?:de\W+|en\W+)?{L}", "intermediate", "any", None),
    (r"\bbasic\W+(?:level\W+)?(?:of\W+)?{L}|\b{L}\W+(?:level\W+)?(?:basic|basico|basica)\b|\b(?:nivel\W+)?basico\W+(?:de\W+|en\W+)?{L}|\bbasic\W+knowledge\W+of\W+{L}", "basic", "any", None),
    # a requirement without a stated level: kept with its evidence, still "unspecified"
    (r"\b(?:proficiency|command|knowledge|dominio|manejo|conocimientos?)\W+(?:\w+\W+){0,1}?(?:of\W+|in\W+|del?\W+|en\W+)?{L}|\b(?:required|requirement|must|mandatory|requerido|requisito|requiere|requieren|necesario|indispensable)\W+(?:\w+\W+){0,2}?{L}|\b{L}\W+(?:is\W+|are\W+)?(?:required|mandatory|a must|necessary|indispensable|requerido|obligatorio)\b", "unspecified", "any", None),
    # "English is a plus" without a level
    (r"\b{L}\W+(?:language\W+)?(?:is\W+)?(?:a\W+|an\W+|un\W+)?(?:plus|nice[- ]to[- ]have|bonus|desirable|deseable|valorable|ideal)\b|\b(?:plus|nice[- ]to[- ]have|bonus|se valora|valorable)\W+(?:\w+\W+){0,2}?{L}", "basic", "any", None),
]
_LEVEL_AFTER = r"\b{L}\W{{0,3}}(?:(?:level|proficiency|skills?|knowledge)\W{{0,3}})?(?:of\W+)?(?P<lv>[abc][12])\b"
_LEVEL_BEFORE = r"\b(?P<lv>[abc][12])\b\W{0,3}(?:level\W+)?(?:of\W+|de\W+|en\W+)?{L}|\bnivel\W+(?P<lv2>[abc][12])\W+(?:de\W+|en\W+)?{L}"
_LEVEL_KIND = {"A1": "basic", "A2": "basic", "B1": "intermediate", "B2": "intermediate", "C1": "advanced", "C2": "advanced"}

# "work with US clients" names no language: it implies spoken English.
_US_CLIENTS = re.compile(
    r"\bwork(?:ing)?\W+(?:directly\W+)?with\W+(?:\w+\W+){0,2}?(?:us|u s|american|north american|usa|english[- ]speaking)\W+(?:based\W+)?(?:clients?|customers?|teams?|stakeholders?)\b|"
    r"\b(?:clients?|customers?)\W+(?:in|from|based in)\W+the\W+(?:us|usa|united states)\b|"
    r"\btrabaj(?:ar|o)\W+con\W+clientes\W+(?:de\W+)?(?:ee\W?uu|estados unidos|usa)\b")


def _build(tpl: str) -> "re.Pattern":
    """Compile a template: every {L} becomes its own named group lg0, lg1... (groups cannot repeat)."""
    n = [0]

    def sub(_m):
        n[0] += 1
        return f"(?P<lg{n[0] - 1}>{LN})"

    return re.compile(re.sub(r"\{L\}", sub, tpl.replace("{LP}", LP)))


def _lang_of(m) -> str | None:
    for name, value in m.groupdict().items():
        if name.startswith("lg") and value:
            return _NAME_CODE.get(value)
    return None


_PATTERNS = [(_build(tpl), kind, skill, level) for tpl, kind, skill, level in _T]
_RX_LEVEL = [_build(_LEVEL_AFTER.replace("{{", "{").replace("}}", "}")), _build(_LEVEL_BEFORE)]


def _clip(segment: str, start: int, end: int) -> str:
    """The text around [start, end) of `segment`, at most MAX_EVIDENCE chars, verbatim."""
    seg = segment.strip(" \t-–—:•·*")
    off = len(segment) - len(segment.lstrip(" \t-–—:•·*"))
    start, end = max(0, start - off), max(0, end - off)
    if len(seg) <= MAX_EVIDENCE:
        return seg
    lo = max(0, min(start - (MAX_EVIDENCE - (end - start)) // 2, len(seg) - MAX_EVIDENCE))
    return seg[lo:lo + MAX_EVIDENCE].strip()


_CLAUSE_BREAK = re.compile(r",|\bbut\b|\bwhile\b|\bhowever\b|\bpero\b|\bmientras\b|\bsin embargo\b")


def _optional_near(folded: str, idx: list, span: tuple) -> bool:
    """True when the clause (comma/but separated) holding the match calls it a plus / nice to have."""
    start = next((i for i, o in enumerate(idx) if o >= span[0]), 0)
    left = max((m.end() for m in _CLAUSE_BREAK.finditer(folded, 0, start)), default=0)
    right = next((m.start() for m in _CLAUSE_BREAK.finditer(folded, start)), len(folded))
    return bool(OPTIONAL.search(folded[left:right]))


def _scan_segment(segment: str, posting_language) -> dict:
    """{lang: record} for one sentence-sized segment."""
    folded, idx = _fold_map(segment)
    found: dict = {}

    def note(code, kind, skill, level, span):
        rec = found.get(code)
        new = {"kind": kind, "skill": skill, "level": level, "span": span}
        if rec is None or _KIND_RANK[kind] < _KIND_RANK[rec["kind"]]:
            if rec is not None:
                if new["level"] is None:
                    new["level"] = rec["level"]
                if skill == "any" and rec["skill"] != "any":
                    new["skill"] = rec["skill"]
            found[code] = new
        else:
            rec["level"] = rec["level"] or level
            if rec["skill"] == "any" and skill != "any":
                rec["skill"] = skill

    for rx_, kind, skill, level in _PATTERNS:
        for m in rx_.finditer(folded):
            # "fluent in English and German": every language named inside the matched span
            for name in re.findall(LN, m.group(0)):
                code = _NAME_CODE.get(name)
                if code:
                    note(code, kind, skill, level, (idx[m.start()], idx[m.end() - 1] + 1))
    for rx_ in _RX_LEVEL:
        for m in rx_.finditer(folded):
            code = _lang_of(m)
            lv = (m.group("lv") or m.groupdict().get("lv2") or "").upper()
            if code and lv in _CEFR:
                note(code, _LEVEL_KIND[lv], "any", lv, (idx[m.start()], idx[m.end() - 1] + 1))
    if "en" not in found:
        m = _US_CLIENTS.search(folded)
        if m:
            found["en"] = {"kind": "conversational", "skill": "speak", "level": None, "span": (idx[m.start()], idx[m.end() - 1] + 1)}
    for code, rec in found.items():
        rec["optional"] = _optional_near(folded, idx, rec["span"])
        rec["evidence"] = _clip(segment, *rec.pop("span"))
    return found


def extract(text, posting_language=None) -> list:
    """Language requirements found in `text` (verbatim evidence), strongest first."""
    text = re.sub(r"[ \t\xa0]+", " ", str(text or ""))
    records: list = []
    for m in SEGMENT.finditer(text):
        segment = m.group(0)
        if len(segment.strip()) < 4:
            continue
        for code, rec in _scan_segment(segment, posting_language).items():
            item = {"lang": code, "skill": rec["skill"], "level": rec["level"], "kind": rec["kind"],
                    "evidence": rec["evidence"], "source": "regex"}
            if rec["optional"]:
                item["optional"] = True
            if item not in records:
                records.append(item)
    records.sort(key=lambda r: (bool(r.get("optional")), _KIND_RANK[r["kind"]]))
    records = records[:MAX_ITEMS]
    code = posting_language if isinstance(posting_language, str) else None
    if code and code in language_levels.known_codes() and code != language_levels.DEFAULT_NATIVE:
        if not any(r["lang"] == code for r in records):
            records.append(unspecified(code, "regex"))
    return records[:MAX_ITEMS]


def unspecified(code: str, source: str = "regex") -> dict:
    return {"lang": code, "skill": "any", "level": None, "kind": "unspecified", "evidence": None, "source": source}


def _evidence(value) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    import posting_guard  # cleaned like any posting text: invisible characters never reach the state

    cleaned, _ = posting_guard.clean_text(value)
    cleaned = " ".join(cleaned.split())
    return cleaned[:MAX_EVIDENCE].strip() or None


def validate(raw):
    """Clean the scoring agent's `language_requirements`; None when it is not a list."""
    if not isinstance(raw, list):
        return None
    out = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        lang = item.get("lang")
        if not isinstance(lang, str) or lang.lower() not in language_levels.known_codes():
            continue
        rec = {
            "lang": lang.lower(),
            "skill": item.get("skill") if item.get("skill") in SKILLS else "any",
            "level": language_levels.parse_level(item.get("level")) if language_levels.parse_level(item.get("level")) != "native" else None,
            "kind": item.get("kind") if item.get("kind") in KINDS else "unspecified",
            "evidence": _evidence(item.get("evidence")),
            "source": item.get("source") if item.get("source") in SOURCES else "llm",
        }
        if item.get("optional") is True:
            rec["optional"] = True
        out.append(rec)
        if len(out) >= MAX_ITEMS:
            break
    return out


# Notes written by the tools themselves (never by the scoring agent): safe to rewrite when the
# requirements change. An agent-written note is kept as it is.
_AUTO_NOTE_PREFIXES = ("La vacante está escrita en", "No especifica el nivel", "Piden ")
_AUTO_NOTE_EXACT = (language_levels.ENGLISH_POSTING_NOTE,)


def is_auto_note(note) -> bool:
    return isinstance(note, str) and (note in _AUTO_NOTE_EXACT or note.startswith(_AUTO_NOTE_PREFIXES) or " aparece como un plus" in note)


def evidence_in_text(requirements: list, text: str) -> list:
    """Drop evidence quotes that are not literally in the posting text (whitespace/case/accent-insensitive)."""
    haystack = _fold_map(" ".join(str(text or "").split()))[0]
    out = []
    for r in requirements:
        ev = r.get("evidence")
        if ev and _fold_map(" ".join(ev.split()))[0] not in haystack:
            r = {**r, "evidence": None}
        out.append(r)
    return out


def from_result(result: dict, posting_language) -> list | None:
    """The requirements to store for one /rank result, or None to leave the entry untouched.

    The agent's `language_requirements` win (validated; evidence kept only when it is verbatim in the
    posting text the result carries). Without them, the regex extractor runs on `posting_text` /
    `description` when the result carries one. No agent list and no text: None.
    """
    text = next((result[k] for k in ("posting_text", "description") if isinstance(result.get(k), str) and result[k].strip()), "")
    if text:
        import posting_guard

        text, _ = posting_guard.clean_text(text)
    reqs = validate(result.get("language_requirements"))
    if reqs is not None:
        return evidence_in_text(reqs, text) if text else reqs
    return extract(text, posting_language) if text else None


def apply(entry: dict, levels: dict, overwrite_note: bool = False) -> None:
    """Rewrite the gate, its note and the auto-added spoken gap from the stored requirements.

    A FAIL gate and an agent-written note are never touched. Legacy entries (no
    `language_requirements`) are left exactly as they are.
    """
    reqs = entry.get("language_requirements")
    if not isinstance(reqs, list):
        return
    code = entry.get("posting_language")
    a = language_levels.requirement_assessment(code, reqs, levels)
    gate = entry.get("language_gate")
    if a["need"] != "none" and gate != "FAIL" and (gate in (None, "PASS") or overwrite_note or is_auto_note(entry.get("language_note"))):
        entry["language_gate"] = a["verdict"]
        if a["verdict"] == "PASS":
            if gate == "PASS" and a["note"] is None:
                entry.pop("language_note", None)
            else:
                entry["language_note"] = a["note"]  # an informative PASS note ("lo cubres")
        else:
            entry["language_note"] = a["note"]
    gaps = entry.get("gaps")
    if isinstance(gaps, list) and a["need"] in ("read_write", "optional", "unspecified"):
        label = language_levels.gap_label(code)
        entry["gaps"] = [g for g in gaps if str(g).strip() != label]


# ---- backfill of already-ranked jobs (no LLM) ---------------------------------------------
ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / "job_scraper" / "seen_jobs.json"
# seen_jobs `portal` prefix -> portal CLI skill with a `detail` command.
CLI_SKILLS = {"himalayas": "himalayas-search", "linkedin": "linkedin-search", "jobicy": "jobicy-search",
              "getonbrd": "getonbrd-search", "remoteok": "remoteok-search", "freehire": "freehire-search",
              "hn-hiring": "hn-hiring-search"}


def cli_skill(entry: dict) -> str | None:
    portal = str(entry.get("portal") or "").lower()
    return next((skill for prefix, skill in CLI_SKILLS.items() if portal.startswith(prefix)), None)


GONE_REASON = "La vacante ya no existe en el portal"


def classify_cli_error(returncode: int, stdout: str) -> str:
    """"gone" only when the portal CLI clearly says the posting does not exist (error code NOT_FOUND);
    timeouts, network errors, HTTP failures and unparseable output are plain "error"."""
    if returncode == 0:
        return "ok"
    try:
        doc = json.loads(stdout)
    except ValueError:
        return "error"
    return "gone" if isinstance(doc, dict) and doc.get("code") == "NOT_FOUND" else "error"


def fetch_posting_text(entry: dict, root: Path = ROOT, timeout: int = 45) -> tuple:
    """("ok", description) | ("gone", None) when the portal says it no longer exists | ("error", None)."""
    import subprocess

    skill, url = cli_skill(entry), entry.get("url")
    if not skill or not isinstance(url, str) or not url.startswith("https://"):
        return "error", None
    cli = root / ".agents" / "skills" / skill / "cli" / "src" / "cli.ts"
    if not cli.is_file():
        return "error", None
    try:
        proc = subprocess.run(["bun", "run", str(cli), "detail", url, "--format", "json"], cwd=root,
                              capture_output=True, text=True, encoding="utf-8", timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return "error", None
    status = classify_cli_error(proc.returncode, proc.stdout or proc.stderr)
    if status != "ok":
        return status, None
    try:
        text = json.loads(proc.stdout).get("description")
    except (ValueError, AttributeError):
        return "error", None
    return ("ok", text) if isinstance(text, str) and text.strip() else ("error", None)


def expire_results(keys) -> list:
    """Results for `rank_state.py apply` that retire postings the portal no longer has (recoverable)."""
    return [{"key": k, "status": "expired", "reason": GONE_REASON} for k in keys]


_STRONG = re.compile(r"\b(?:c1|c2|b2\+?)\b|fluen|fluid|conversational|conversacional|nativ")
_NEAR = r"(?:interview|entrevista|meeting|reunion|junta|calls?|llamadas?|stand-?ups?|clients?|clientes?|customers?|communication skills|habilidades de comunicacion)"
_LANG = r"(?:ingles|english)"
_CONCRETE = re.compile(
    rf"{_NEAR}[^.]{{0,40}}{_LANG}|{_LANG}[^.]{{0,40}}{_NEAR}"
    r"|ingles\s+avanzado|avanzado\s+(?:de|en)\s+ingles|advanced\s+english|english\s+advanced")
_CAN_BE_FLUENT = re.compile(r"fluen|fluid|\b(?:c1|c2)\b|nativ|ingles\s+avanzado|avanzado\s+(?:de|en)\s+ingles|advanced\s+english|english\s+advanced")


_HEDGE = re.compile(r"probablemente|se asume|se supone|posiblemente|podria|puede que|quiza|seguramente|likely|probably|assum")
_TOOL_NOTE = re.compile(r"^(?:Piden .+?\.(?: «.+»\.)? (?:Tu nivel (?:hablado|de lectura)|No tienes)|No especifica el nivel|.+ aparece como un plus)")


def _firm_part(text: str) -> str:
    """The clauses of `text` that are not hedged ("probablemente haya llamadas" is a guess, not evidence)."""
    return " . ".join(p for p in re.split(r"[.;:]", str(text)) if p.strip() and not _HEDGE.search(language_levels._fold(p)))


def _has_concrete_evidence(text: str) -> bool:
    folded = language_levels._fold(_firm_part(text))
    return bool(_STRONG.search(folded) or _CONCRETE.search(folded))


def _mentions(code: str, text) -> bool:
    folded = language_levels._fold(text)
    spec = language_levels._LANGS[code]
    return any(re.search(rf"\b{re.escape(language_levels._fold(n))}\b", folded) for n in (spec[0], *spec[1]))


def llm_hint(entry: dict) -> dict | None:
    """What an earlier LLM analysis stated about spoken language, as a requirement record; None when it stated nothing.

    Counts as spoken (source "llm", no quote: the text is not the posting's) only when the stated text holds
    concrete evidence: a level, fluent/conversational, or interviews/meetings/calls/clients in the language.
    The old-rule template ("La vacante está escrita en inglés: probablemente se requiere inglés hablado") and
    anything that only says the posting is written in the language is an ASSUMPTION: kind unspecified,
    source "llm_assumption", so the soft-flag rule applies.
    """
    code = entry.get("posting_language")
    if code not in language_levels.known_codes():
        return None
    def states_spoken(text) -> bool:
        return language_levels.stated_gap_language(text) == code or (_mentions(code, text) and _has_concrete_evidence(str(text)))

    texts = [str(g) for g in entry.get("gaps") or [] if states_spoken(g)]
    note = entry.get("language_note")
    if note and not _TOOL_NOTE.match(str(note)) and states_spoken(note):  # a note this tool wrote is not LLM evidence
        texts.append(str(note))
    if not texts:
        return None
    joined = " . ".join(texts)
    if not _has_concrete_evidence(joined):
        return {**unspecified(code, "llm_assumption")}
    kind = "fluent" if _CAN_BE_FLUENT.search(language_levels._fold(_firm_part(joined))) else "conversational"
    return {"lang": code, "skill": "speak", "level": None, "kind": kind, "evidence": None, "source": "llm"}


def _drop_assumed_spoken_gaps(entry: dict) -> None:
    code = entry.get("posting_language")
    gaps = entry.get("gaps")
    if isinstance(gaps, list):
        entry["gaps"] = [g for g in gaps if language_levels.stated_gap_language(g) != code]


def _set_requirements(entry: dict, reqs: list, levels: dict) -> None:
    entry["language_requirements"] = reqs
    assumption = len(reqs) == 1 and reqs[0].get("source") == "llm_assumption"
    if assumption:
        _drop_assumed_spoken_gaps(entry)  # the "Inglés hablado: ... está escrita en inglés" gaps were never evidence
    apply(entry, levels, overwrite_note=assumption)


def redo_llm_hints(seen: dict, levels: dict, original: dict | None = None) -> dict:
    """Re-judge records an earlier backfill took from LLM text (source llm, no quote).

    The judgement reads the notes and gaps of `original` (the state from before any language_requirements were
    written) when given, because the tool has since rewritten the current ones. Without concrete evidence a record
    becomes an assumption (unspecified, soft flag); with it the record is rebuilt. No fetch.
    Returns {"checked", "downgraded", "kept"}.
    """
    out = {"checked": 0, "downgraded": 0, "kept": 0}
    for key, entry in seen.items():
        reqs = entry.get("language_requirements")
        if not (isinstance(reqs, list) and reqs and all(r.get("source") == "llm" and not r.get("evidence") and r.get("skill") == "speak" for r in reqs)):
            continue
        out["checked"] += 1
        src = original.get(key) if original else None
        hint = llm_hint({**entry, "gaps": src.get("gaps"), "language_note": src.get("language_note")} if src else entry)
        if hint is None:
            out["kept"] += 1
            continue
        if src and src.get("gaps") is not None and hint["source"] == "llm":
            entry["gaps"] = list(src["gaps"])  # the original wording, which the earlier backfill may have trimmed
        _set_requirements(entry, [hint], levels)
        out["downgraded" if hint["source"] == "llm_assumption" else "kept"] += 1
    return out


def backfill_state(seen: dict, levels: dict, fetch, concurrency: int = 2, delay: float = 0.4, limit: int | None = None,
                   log=lambda line: None) -> dict:
    """Give every ranked entry without `language_requirements` its requirements. Returns a summary.

    `fetch(entry) -> text|None` is the only network access. Entries whose posting cannot be fetched
    because no CLI serves them (Indeed) are marked unspecified with source "none"; failed fetches are
    left untouched so a later run retries them.
    """
    import concurrent.futures
    import time

    todo = [(k, e) for k, e in seen.items() if e.get("status") == "ranked" and not isinstance(e.get("language_requirements"), list)]
    if limit:
        todo = todo[:limit]
    summary = {"candidates": len(todo), "fetched": 0, "failed": 0, "no_cli": 0, "kept_from_llm": 0, "assumptions": 0,
               "gone": [], "kinds": {}, "failed_keys": []}

    def work(item):
        key, entry = item
        if cli_skill(entry) is None:
            return key, "no_cli", ("error", None)
        time.sleep(delay)
        return key, "ok", fetch(entry)

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
        for n, (key, how, fetched) in enumerate(pool.map(work, todo), 1):
            status, text = fetched if isinstance(fetched, tuple) else ("error", None)
            entry = seen[key]
            code = entry.get("posting_language")
            if how == "no_cli":
                reqs = [unspecified(code, "none")] if code in language_levels.known_codes() and code != "es" else []
                summary["no_cli"] += 1
            elif status == "gone":
                summary["gone"].append(key)   # the portal says it is gone: left as it is, reported for the expiry step
                continue
            elif text is None:
                summary["failed"] += 1
                summary["failed_keys"].append(key)
                continue
            else:
                summary["fetched"] += 1
                import posting_guard

                reqs = extract(posting_guard.guard(text, "auto")[0], code)
                if all(r["kind"] == "unspecified" for r in reqs):
                    hint = llm_hint(entry)
                    if hint:
                        reqs = [hint]
                        summary["assumptions" if hint["source"] == "llm_assumption" else "kept_from_llm"] += 1
            _set_requirements(entry, reqs, levels)
            kinds = summary["kinds"].setdefault(str(code), {})
            for r in reqs:
                label = "optional" if r.get("optional") else r["kind"]
                kinds[label] = kinds.get(label, 0) + 1
            if n % 25 == 0:
                log(f"{n}/{len(todo)} vacantes revisadas")
    return summary


def _merge_write(args, seen: dict) -> None:
    import shutil

    if args.backup:
        args.backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(args.state, args.backup)
    # Re-read right before writing: the dashboard may have changed other entries during the fetches.
    fresh = json.loads(args.state.read_text(encoding="utf-8"))
    for key, entry in seen.items():
        if isinstance(entry.get("language_requirements"), list) and key in fresh["seen"]:
            target = fresh["seen"][key]
            for field in ("language_requirements", "language_gate", "language_note", "gaps"):
                if field in entry:
                    target[field] = entry[field]
                else:
                    target.pop(field, None)
    tmp = args.state.with_name(args.state.name + ".langreq.tmp")
    tmp.write_text(json.dumps(fresh, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(args.state)


def _expire(args, keys: list) -> dict:
    """Retire postings the portal says are gone through rank_state's own expiry (status expired, never deleted)."""
    import subprocess
    import tempfile

    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as fh:
        json.dump(expire_results(keys), fh, ensure_ascii=False)
    try:
        proc = subprocess.run([sys.executable, str(Path(__file__).with_name("rank_state.py")), "apply", "--results", fh.name,
                               "--state", str(args.state)], capture_output=True, text=True, encoding="utf-8")
    finally:
        Path(fh.name).unlink(missing_ok=True)
    return {"requested": len(keys), "returncode": proc.returncode, "expired": len(json.loads(proc.stdout).get("expired", [])) if proc.returncode == 0 else 0}


def cmd_backfill(args) -> int:
    import profile_config

    doc = json.loads(args.state.read_text(encoding="utf-8"))
    seen = doc["seen"]
    levels = language_levels.user_levels(profile_config.load())
    if args.redo_llm_hints:
        original = json.loads(args.original.read_text(encoding="utf-8"))["seen"] if args.original else None
        summary = redo_llm_hints(seen, levels, original)
    else:
        summary = backfill_state(seen, levels, lambda e: fetch_posting_text(e, timeout=args.timeout), args.concurrency, args.delay,
                                 args.limit, log=lambda line: print(line, file=sys.stderr))
    if args.write:
        _merge_write(args, seen)
        if args.expire_gone and summary.get("gone"):
            summary["expiry"] = _expire(args, summary["gone"])
    print(json.dumps({**summary, "written": bool(args.write)}, ensure_ascii=False, indent=2))
    return 0


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    ex = sub.add_parser("extract", help="print the requirements found in a text")
    ex.add_argument("--text", help="posting text (default: stdin)")
    ex.add_argument("--posting-language", default=None)
    ex.set_defaults(func=lambda a: print(json.dumps(extract(a.text if a.text is not None else sys.stdin.read(), a.posting_language), ensure_ascii=False, indent=2)) or 0)
    bf = sub.add_parser("backfill", help="read the requirements of already-ranked jobs from their posting (no LLM)")
    bf.add_argument("--state", type=Path, default=STATE)
    bf.add_argument("--write", action="store_true")
    bf.add_argument("--backup", type=Path, default=None, help="copy of the state file made before writing")
    bf.add_argument("--concurrency", type=int, default=2)
    bf.add_argument("--delay", type=float, default=0.4, help="seconds each worker waits before a fetch")
    bf.add_argument("--timeout", type=int, default=45)
    bf.add_argument("--limit", type=int, default=None)
    bf.add_argument("--redo-llm-hints", action="store_true", help="re-judge earlier LLM-derived records (no fetch)")
    bf.add_argument("--original", type=Path, default=None, help="with --redo-llm-hints: the state from before the first backfill")
    bf.add_argument("--expire-gone", action="store_true", help="retire postings the portal CLI says no longer exist (needs --write)")
    bf.set_defaults(func=cmd_backfill)
    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
