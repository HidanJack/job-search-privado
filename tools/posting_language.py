#!/usr/bin/env python3
"""Detect the language a job posting is written in and backfill seen_jobs.json.

`/rank` records `posting_language` (an ISO 639-1 code such as "es", "en",
"de", "pt", "fr", "it", "nl", or "mixed") for each scored posting, and
rank_state.py turns it into the language gate (language_levels.py): a posting
in a language the candidate does not speak becomes a FLAG with a spoken-language
gap. Entries ranked before that rule have no `posting_language`, so the UI's
"hide languages I do not speak" filter hides none of them. This tool fills the
gap without re-scoring anything.

Detection is a function-word count, not a model call. The text is lowercased
and stripped of HTML; the hits of each language's word list are counted:

  * fewer than MIN_HITS hits in total          -> None (too little signal)
  * one language holds >= DOMINANT_SHARE (80%) -> that language
  * otherwise                                  -> "mixed"

Spanish and English use the original two lists (words valid in both, such as
"a", "no", "me", "he", "son", are left out of both). Every other language
(de, pt, fr, it, nl) has a list of words that exist in neither Spanish nor
English, plus job-title vocabulary (counted double, so a short title such as
"Softwareentwickler" still decides) and distinctive characters/markers
("ß", "ã", "(m/w/d)", one hit each). A non-es/en language takes over only with at least
3 exclusive hits in a body (2 in a title), so Spanish and English texts keep
their historical result. `detect()` is the same with "unknown" instead of None.

Subcommands:
  detect   --text TEXT | --file PATH [--title]
                                           print the detected language code
                                           (mixed / none for no signal)
  backfill [--state PATH] [--dry-run]      fill `posting_language` on ranked
                                           entries that lack it

backfill fetches each posting with its portal CLI (`detail <url> --format
json`), falls back to the title when no description is available, and writes
ONLY `posting_language` plus what rank_state.enforce_language_rule derives from
it (language_gate/language_note/gaps). A failed fetch leaves the entry
untouched and is reported. Portal "indeed" cannot be fetched from Python (its
detail is an MCP tool), so backfill leaves those entries alone and lists them under "none";
/rank records their posting_language when it reads the detail.
"""
import argparse
import html
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rank_state  # noqa: E402  (shares the English-posting rule, not a copy)

ROOT = Path(__file__).resolve().parent.parent
STATE = rank_state.STATE

MIN_HITS = 8  # total stopword hits needed to call a description
TITLE_MIN_HITS = 2  # titles are short; a clear one still has a few stopwords
DOMINANT_SHARE = 0.8
FETCH_TIMEOUT = 60  # seconds, enforced by subprocess itself

SPANISH = frozenset(
    """el la los las un una unos unas de del al y o u que en con por para como
    se su sus es son está están ser fue ha han más pero sobre entre sin también
    nuestro nuestra nuestros nuestras tu tus te lo le les este esta estos estas
    ese esa muy o experiencia equipo trabajo buscamos años requisitos ofrecemos
    puesto empresa desarrollo conocimientos habilidades cuando donde""".split()
)
ENGLISH = frozenset(
    """the and of to in for with on at by from is are was were be been will you
    your we our us their they it its this that these those or as an have has
    must can should about who which what experience team work years looking
    required requirements skills ability including across strong join role
    company responsibilities""".split()
)
# "experiencia/experience", "o", etc. are separate words in each set; drop the
# few accidental overlaps so a shared word never counts for both.
_SHARED = SPANISH & ENGLISH
SPANISH = SPANISH - _SHARED
ENGLISH = ENGLISH - _SHARED

TAG = re.compile(r"<[^>]+>")
WORD = re.compile(r"[a-záéíóúüñ]+")
WORD_U = re.compile(r"[^\W\d_]+")
PORTAL_CLI = ".agents/skills/{portal}/cli/src/cli.ts"

MIN_OTHER_BODY = 3  # exclusive hits a non-es/en language needs in a body
MIN_OTHER_TITLE = 2  # ... and in a title (job words count double)

# Words shared by the languages below with Spanish / English: counted for neither side
# when that language is the candidate (so "de que para" does not make Portuguese look
# half Spanish, and the borrowed "team" does not make German look half English).
BORROWED_EN = frozenset("team in an is was of we will as a on or can".split())

# Function words that exist in neither Spanish nor English, plus job vocabulary (JOB, double weight).
_STOP = {
    "de": """der die das den dem des ein eine einen einem einer eines und oder nicht mit für fur von vom zu zum zur
        auf bei aus über uber wir sie ihr ihre ihren ist sind wird werden haben hat sich auch wie als wenn dass
        sowie unser unsere unserem unseren sondern aber noch nur""".split(),
    "pt": """um uma uns umas dos das em com não nao também tambem você voce vocês voces nós ele ela eles elas
        seu sua seus suas nosso nossa nossos nossas mais pela pelo pelas pelos ao aos muito é pessoa dados qualidade
        trabalho equipe anos conhecimento conhecimentos""".split(),
    "fr": """le des une sont pour dans avec vous nous notre nos votre vos ce cette ces qui et du au aux ne pas sur
        aussi être""".split(),
    "it": """il gli di che sono della dello dei delle degli nella nel nei alla alle anche più piu nostro nostra
        nostri nostre uno è questo questa essere ogni nelle sul sulla buona buono laurea capacità responsabilità conoscenza
        lavoro azienda requisiti competenze offriamo""".split(),
    "nl": """het een van op voor zijn wij jij ons onze ook bij naar niet dat deze wordt worden heeft hebben als uw
        werken kennis""".split(),
}
_JOB = {
    "de": """entwickler entwicklerin softwareentwickler ingenieur ingenieurin mitarbeiter mitarbeiterin stelle berater
        beraterin leiter leiterin erfahrung kenntnisse aufgaben anforderungen bewerbung unternehmen stellenangebot
        praktikant werkstudent""".split(),
    "pt": """desenvolvedor desenvolvedora engenheiro engenheira vaga vagas estágio estagio estagiário
        desenvolvimento engenharia experiência requisitos""".split(),
    "fr": """ingénieur développeur développeuse poste emploi expérience équipe entreprise compétences stage
        alternance recherchons""".split(),
    "it": """sviluppatore sviluppatrice ingegnere esperienza lavoro azienda ricerchiamo stage tirocinio
        competenze""".split(),
    "nl": """ontwikkelaar medewerker vacature ervaring vaardigheden bedrijf functie vereisten zoeken""".split(),
}
# Words each language shares with Spanish (and the shared English ones are BORROWED_EN).
_SHARED_ES = {
    "de": frozenset("es".split()),
    "pt": frozenset("de que para por como se o sobre entre".split()),
    "fr": frozenset("de la les un en que se".split()),
    "it": frozenset("con un una lo la o se del al".split()),
    "nl": frozenset("de en".split()),
}
# markers worth two hits: gender suffixes of German job titles, distinctive letters
# (m/w/d), (w/m/d), (m/w/x): the German gender tag, one hit only: English-language postings from German
# companies carry it too, so it never decides a title alone. "(m/f/d)" is English and says nothing.
_MARKERS = {"de": re.compile(r"\b(?:m/w/[dx]|w/m/[dx]|m/w)\b")}
_LETTERS = {"de": "ß", "pt": "ãõ"}


def _build() -> dict:
    words = {c: set(_STOP[c]) | set(_JOB[c]) for c in _STOP}
    exclusive = {}
    for code, ws in words.items():
        others = set().union(*(w for c, w in words.items() if c != code))
        exclusive[code] = frozenset(w for w in ws if w not in SPANISH and w not in ENGLISH and w not in others)
    return exclusive


EXCLUSIVE = _build()
JOB_WORDS = {c: frozenset(_JOB[c]) & EXCLUSIVE[c] for c in _JOB}


def normalize(text: str) -> str:
    return html.unescape(TAG.sub(" ", text or "")).lower()


def _counts(text: str) -> tuple[int, int]:
    words = WORD.findall(normalize(text))
    return sum(w in SPANISH for w in words), sum(w in ENGLISH for w in words)


def _other_hits(text: str) -> dict:
    """Weighted hits per non-es/en language (job words and markers count double)."""
    norm = normalize(text)
    tokens = WORD_U.findall(norm)
    out = {}
    for code, excl in EXCLUSIVE.items():
        hits = sum(2 if w in JOB_WORDS[code] else 1 for w in tokens if w in excl)
        marker = _MARKERS.get(code)
        if marker:
            hits += len(marker.findall(norm))
        hits += sum(norm.count(ch) for ch in _LETTERS.get(code, ""))
        out[code] = hits
    return out


def detect_language(text: str, min_hits: int = MIN_HITS) -> str | None:
    """Return a language code, "mixed", or None when the text is too short to tell."""
    es, en = _counts(text)
    other = _other_hits(text)
    best = max(other, key=lambda c: other[c])
    need = MIN_OTHER_TITLE if min_hits <= TITLE_MIN_HITS else MIN_OTHER_BODY
    if other[best] >= need:
        words = WORD.findall(normalize(text))
        es_x = sum(w in SPANISH and w not in _SHARED_ES[best] for w in words)
        en_x = sum(w in ENGLISH and w not in BORROWED_EN for w in words)
        shares = {best: other[best], "es": es_x, "en": en_x}
        shares.update({c: n for c, n in other.items() if c != best})
        total = sum(shares.values())
        top = max(shares, key=lambda c: shares[c])
        return top if shares[top] / total >= DOMINANT_SHARE else "mixed"
    total = es + en
    if total < min_hits:
        return None
    if es / total >= DOMINANT_SHARE:
        return "es"
    if en / total >= DOMINANT_SHARE:
        return "en"
    return "mixed"


def detect(text: str, kind: str = "body") -> str:
    """Like detect_language / detect_title, but "unknown" instead of None."""
    result = detect_title(text) if kind == "title" else detect_language(text)
    return result or "unknown"


def detect_title(title: str) -> str | None:
    """Titles only count when clearly one language; never "mixed"."""
    result = detect_language(title, min_hits=TITLE_MIN_HITS)
    return None if result == "mixed" else result


def fetch_detail(entry: dict, run=subprocess.run) -> dict:
    """Run the portal CLI's `detail` and return its parsed JSON. Raises on failure."""
    portal = entry.get("portal")
    if portal == "indeed":
        # Indeed is reachable only through an MCP tool, which Python cannot call.
        raise RuntimeError("indeed postings need the MCP connector; skipped")
    target = entry.get("url") or entry.get("id")
    if not portal or not target:
        raise RuntimeError("entry has no portal/url")
    cli = ROOT / PORTAL_CLI.format(portal=portal)
    if not cli.is_file():
        raise RuntimeError(f"no CLI for portal {portal}")
    proc = run(
        ["bun", "run", str(cli), "detail", str(target), "--format", "json"],
        shell=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=FETCH_TIMEOUT,
        cwd=str(ROOT),
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or "detail failed").strip()[:200])
    data = json.loads(proc.stdout)
    if not isinstance(data, dict):
        raise RuntimeError("unexpected detail output")
    return data


def language_for(entry: dict, fetch=fetch_detail) -> tuple[str | None, str]:
    """Return (language, source) where source is "description", "title" or "none"."""
    detail = fetch(entry)
    language = detect_language(detail.get("description") or "")
    if language:
        return language, "description"
    language = detect_title(detail.get("title") or entry.get("title") or "")
    return (language, "title") if language else (None, "none")


def backfill(state: Path, dry_run: bool = False, fetch=fetch_detail) -> dict:
    doc, seen = rank_state.load_state(state)
    summary = {"none": [], "failed": []}
    for key, entry in seen.items():
        if entry.get("status") != "ranked" or entry.get("posting_language"):
            continue
        if entry.get("portal") == "indeed":
            summary["none"].append(key)  # MCP-only portal: no fetch possible from Python
            continue
        try:
            language, source = language_for(entry, fetch)
        except Exception as exc:  # a failed detail must not stop the others
            summary["failed"].append({"key": key, "error": str(exc)})
            continue
        if language is None:
            summary["none"].append(key)
            continue
        entry["posting_language"] = language
        rank_state.enforce_language_rule(entry)
        summary.setdefault(language, []).append(key)
    if not dry_run and any(v for k, v in summary.items() if k not in ("none", "failed")):
        rank_state.save_state(state, doc)
    return summary


def cmd_detect(args) -> int:
    if args.file:
        text = Path(args.file).read_text(encoding="utf-8")
    else:
        text = args.text or ""
    result = detect_title(text) if getattr(args, "title", False) else detect_language(text)
    print(result or "none")
    return 0


def cmd_backfill(args) -> int:
    summary = backfill(args.state, args.dry_run)
    print(
        json.dumps(
            {"dry_run": args.dry_run, "counts": {k: len(v) for k, v in summary.items()}, **summary},
            indent=2,
            ensure_ascii=False,
        )
    )
    return 1 if summary["failed"] else 0


def main() -> int:
    rank_state._force_utf8_output()
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="command", required=True)
    det = sub.add_parser("detect", help="detect the language of a text")
    group = det.add_mutually_exclusive_group(required=True)
    group.add_argument("--text")
    group.add_argument("--file")
    det.add_argument("--title", action="store_true", help="treat the text as a job title (short, never mixed)")
    det.set_defaults(func=cmd_detect)
    bf = sub.add_parser("backfill", help="fill posting_language on ranked entries lacking it")
    bf.add_argument("--state", type=Path, default=STATE)
    bf.add_argument("--dry-run", action="store_true")
    bf.set_defaults(func=cmd_backfill)
    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
