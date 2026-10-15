#!/usr/bin/env python3
"""Check a cover letter source for screening-era length and generic-AI phrasing.

Rules come from `10-ats-and-screening.md` ("Cover letters"): a body of roughly
150-250 words, and none of the stock phrases hiring managers single out as
reading like unedited AI output. Hiring-manager surveys put rejection of
generic AI material at roughly 20% outright, with a third saying they spot it
in under 20 seconds - so a phrase list is a cheap, deterministic first filter.
It cannot judge specificity; `/apply`'s reviewer still does that.

The body is the text of every `\\lettercontent{...}` block plus every `\\item`,
minus the salutation (the first block) and the sign-off line (the last block),
with LaTeX commands stripped. Works on the stock `cover.cls` source; for a
custom template, pass the compiled PDF's dumped text with `--plain`.

Usage:
  python3 tools/check_cover_letter.py cover_letters/cover_<company>_<role>.tex
  python3 tools/check_cover_letter.py letter.txt --plain [--min-words N] [--max-words N]

Exit 0 when clean, 1 on any problem (each one listed), 2 on a usage error.
"""

import argparse
import re
import sys
from pathlib import Path

MIN_WORDS = 150
MAX_WORDS = 250

# English and Spanish stock phrases. Matched case-insensitively on whole words.
BANNED_PHRASES = [
    "i am excited to apply",
    "i am thrilled",
    "i am writing to express my interest",
    "passionate about",
    "passion for",
    "fast-paced environment",
    "fast paced environment",
    "leverage",
    "leveraging",
    "i believe i would be a great fit",
    "i would be a great fit",
    "perfect fit",
    "proven track record",
    "team player",
    "synergy",
    "dynamic environment",
    "hit the ground running",
    "think outside the box",
    "cutting-edge",
    "me apasiona",
    "mi pasión",
    "apasionado por",
    "apasionada por",
    "entorno dinámico",
    "ambiente dinámico",
    "con gran entusiasmo",
    "me complace postularme",
    "estoy emocionado",
    "estoy emocionada",
    "trabajo en equipo y bajo presión",
    "sinergia",
    "candidato ideal",
    "candidata ideal",
]


def _braced(text, start):
    """Return the content of the brace group opening at text[start] == '{'."""
    depth, i = 0, start
    while i < len(text):
        if text[i] == "\\":
            i += 2
            continue
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start + 1 : i]
        i += 1
    return text[start + 1 :]


def strip_latex(text):
    text = re.sub(r"(?<!\\)%.*", "", text)
    text = re.sub(r"\\(?:textbf|textit|emph|underline|href\{[^}]*\})\{", "{", text)
    text = re.sub(r"\\[a-zA-Z]+\*?(?:\[[^\]]*\])?", " ", text)
    text = text.replace("~", " ").replace("--", "-")
    text = re.sub(r"[{}\\]", " ", text)
    return " ".join(text.split())


def letter_body(source):
    """Body text of a cover.cls letter, salutation and sign-off excluded."""
    blocks = []
    for match in re.finditer(r"\\lettercontent\s*\{", source):
        blocks.append(strip_latex(_braced(source, match.end() - 1)))
    items = [strip_latex(m.group(1)) for m in re.finditer(r"\\item\s+(.*)", source)]
    body = blocks[1:-1] if len(blocks) >= 3 else blocks
    return " ".join(body + items)


def find_banned_phrases(text):
    lowered = " ".join(text.lower().split())
    hits = []
    for phrase in BANNED_PHRASES:
        if re.search(rf"(?<![\w-]){re.escape(phrase)}(?![\w-])", lowered):
            hits.append(phrase)
    return hits


def word_count(text):
    return len(re.findall(r"[^\W_][\w'’.-]*", text))


def check(text, min_words=MIN_WORDS, max_words=MAX_WORDS):
    problems = []
    count = word_count(text)
    if count < min_words or count > max_words:
        problems.append(f"body is {count} words; aim for {min_words}-{max_words}")
    banned = find_banned_phrases(text)
    if banned:
        problems.append("generic phrasing that reads as AI-written: " + ", ".join(repr(b) for b in banned))
    return count, problems


def _force_utf8_output():
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            reconfigure(encoding="utf-8")


def main(argv=None):
    _force_utf8_output()
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("path", type=Path)
    parser.add_argument("--plain", action="store_true", help="input is plain text, not cover.cls LaTeX")
    parser.add_argument("--min-words", type=int, default=MIN_WORDS)
    parser.add_argument("--max-words", type=int, default=MAX_WORDS)
    args = parser.parse_args(argv)
    try:
        source = args.path.read_text(encoding="utf-8")
    except OSError as exc:
        print(f"Error: cannot read {args.path}: {exc}", file=sys.stderr)
        return 2
    text = source if args.plain else letter_body(source)
    count, problems = check(text, args.min_words, args.max_words)
    if problems:
        for problem in problems:
            print(f"Problem: {args.path}: {problem}", file=sys.stderr)
        return 1
    print(f"Cover letter OK: {args.path} ({count} body words)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
