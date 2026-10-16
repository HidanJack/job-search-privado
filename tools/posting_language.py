#!/usr/bin/env python3
"""Detect the language a job posting is written in and backfill seen_jobs.json.

`/rank` records `posting_language` ("es" | "en" | "mixed") for each scored
posting, and rank_state.py turns "en" into a language_gate FLAG plus a
spoken-English gap. Entries ranked before that rule have no
`posting_language`, so the UI's `hideEnglish` filter hides none of them. This
tool fills the gap without re-scoring anything.

Detection is a stopword count, not a model call. The text is lowercased and
stripped of HTML; the hits of the Spanish and English stopword sets are
counted and compared:

  * fewer than MIN_HITS hits in total          -> None (too little signal)
  * one language holds >= DOMINANT_SHARE (80%) -> that language
  * otherwise                                  -> "mixed"

Words that are valid in both languages ("a", "no", "me", "he", "son"...) are
left out of both sets so they cannot tip the balance.

Subcommands:
  detect   --text TEXT | --file PATH       print the detected language
  backfill [--state PATH] [--dry-run]      fill `posting_language` on ranked
                                           entries that lack it

backfill fetches each posting with its portal CLI (`detail <url> --format
json`), falls back to the title when no description is available, and writes
ONLY `posting_language` plus what rank_state.enforce_english_rule derives from
"en" (language_gate/language_note/gaps). A failed fetch leaves the entry
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
PORTAL_CLI = ".agents/skills/{portal}/cli/src/cli.ts"


def normalize(text: str) -> str:
    return html.unescape(TAG.sub(" ", text or "")).lower()


def _counts(text: str) -> tuple[int, int]:
    words = WORD.findall(normalize(text))
    return sum(w in SPANISH for w in words), sum(w in ENGLISH for w in words)


def detect_language(text: str, min_hits: int = MIN_HITS) -> str | None:
    """Return "es", "en", "mixed", or None when the text is too short to tell."""
    es, en = _counts(text)
    total = es + en
    if total < min_hits:
        return None
    if es / total >= DOMINANT_SHARE:
        return "es"
    if en / total >= DOMINANT_SHARE:
        return "en"
    return "mixed"


def detect_title(title: str) -> str | None:
    """Titles only count when clearly one language; never "mixed"."""
    result = detect_language(title, min_hits=TITLE_MIN_HITS)
    return result if result in ("es", "en") else None


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
    summary = {"es": [], "en": [], "mixed": [], "none": [], "failed": []}
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
        rank_state.enforce_english_rule(entry)
        summary[language].append(key)
    if not dry_run and (summary["es"] or summary["en"] or summary["mixed"]):
        rank_state.save_state(state, doc)
    return summary


def cmd_detect(args) -> int:
    if args.file:
        text = Path(args.file).read_text(encoding="utf-8")
    else:
        text = args.text or ""
    print(detect_language(text) or "none")
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
    det.set_defaults(func=cmd_detect)
    bf = sub.add_parser("backfill", help="fill posting_language on ranked entries lacking it")
    bf.add_argument("--state", type=Path, default=STATE)
    bf.add_argument("--dry-run", action="store_true")
    bf.set_defaults(func=cmd_backfill)
    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
