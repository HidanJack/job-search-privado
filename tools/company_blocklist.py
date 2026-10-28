#!/usr/bin/env python3
"""Company blocklist ("lista negra"): normalization, matching, validation and suggestions.

The list lives in the gitignored profile_config.json as
  "blocked_companies": [{"name", "aliases": [], "reason", "added": "YYYY-MM-DD"}]

Matching uses a normalized company name: lowercase, accents folded, punctuation and spaces
collapsed, legal suffixes removed ("S.A. de C.V.", "Inc", "LLC", "Ltd"...). A company is blocked
when its normalized name EQUALS the normalized name or an alias of an entry, or CONTAINS it as
whole words ("TV Spam Deportes" contains "tv spam"; "Spamalot" does not contain "spam").
A word that only some blocked names share never matches on its own.

Mirrored in ui/lib/blocklist.ts. Nothing here deletes anything: the prefilter marks blocked
pending jobs `prefiltered_out` (recoverable) and the UI hides blocked ranked jobs.

Usage:
  python3 tools/company_blocklist.py suggest [--state PATH]
  python3 tools/company_blocklist.py count [--state PATH]     # postings per blocked company
"""
import argparse
import json
import re
import statistics
import sys
import unicodedata
from collections import Counter
from datetime import date
from pathlib import Path

MAX_ENTRIES = 200
MAX_NAME = 80
MAX_ALIASES = 10
MAX_REASON = 200
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")
REASON_OUT = "Empresa en tu lista negra"

# Legal suffixes, as folded token sequences, longest first. Removed from the END of a name, repeatedly.
_SUFFIXES = tuple(sorted((
    "s a p i de c v", "s a b de c v", "s a de c v", "s de r l de c v", "s de r l", "sa de cv", "sapi de cv",
    "s a p i", "s a", "sa", "inc", "llc", "ltd", "limited", "corp", "corporation", "gmbh", "co", "plc", "sas", "srl",
), key=lambda s: -len(s.split())))

SUGGEST_MIN_POSTINGS = 8
SUGGEST_MEDIAN_AGE_DAYS = 30
SUGGEST_REPOST_SHARE = 0.4
SUGGEST_MIN_REPOSTS = 3


def normalize(name) -> str:
    text = unicodedata.normalize("NFKD", str(name or "")).casefold()
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = " ".join(re.sub(r"[^0-9a-z\u0080-￿]+", " ", text).split())
    changed = True
    while changed:
        changed = False
        for suffix in _SUFFIXES:
            if text.endswith(" " + suffix) and len(text) > len(suffix) + 1:
                text, changed = text[: -len(suffix) - 1].rstrip(), True
                break
    return text


def _names(entry: dict) -> set:
    return {n for n in (normalize(entry.get("name")), *(normalize(a) for a in entry.get("aliases") or [])) if n}


def find_blocked(company, entries) -> dict | None:
    """The blocklist entry that blocks `company`, else None."""
    c = normalize(company)
    if not c or not entries:
        return None
    padded = f" {c} "
    for entry in entries:
        for n in _names(entry):
            if c == n or f" {n} " in padded:
                return entry
    return None


def parse_entries(raw) -> list:
    """Valid entries only ({name, aliases, reason?, added: ISO|None}); duplicates by normalized name dropped."""
    if not isinstance(raw, list):
        return []
    out, seen = [], set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = " ".join(str(item.get("name")).split()) if isinstance(item.get("name"), str) else ""
        key = normalize(name)
        if not name or len(name) > MAX_NAME or not key or key in seen:
            continue
        aliases = []
        for a in item.get("aliases") if isinstance(item.get("aliases"), list) else []:
            if isinstance(a, str) and a.strip() and len(a.strip()) <= MAX_NAME and a.strip() not in aliases:
                aliases.append(" ".join(a.split()))
        entry = {"name": name, "aliases": aliases[:MAX_ALIASES], "added": item["added"] if isinstance(item.get("added"), str) and ISO.match(item["added"]) else None}
        if isinstance(item.get("reason"), str) and item["reason"].strip():
            entry["reason"] = " ".join(item["reason"].split())[:MAX_REASON]
        seen.add(key)
        out.append(entry)
        if len(out) >= MAX_ENTRIES:
            break
    return out


def _age(entry: dict, today: date):
    try:
        return max(0, (today - date.fromisoformat(str(entry.get("posted_date"))[:10])).days)
    except ValueError:
        return None


def suggestions(seen: dict, blocked, today: date) -> list:
    """Companies with many stale or reposted postings, as hints for the user. NEVER blocks anything.

    A company qualifies with at least SUGGEST_MIN_POSTINGS postings in seen_jobs and either a median
    posting age above SUGGEST_MEDIAN_AGE_DAYS or many reposts. Companies already blocked are skipped.
    """
    groups: dict = {}
    for entry in seen.values():
        if not isinstance(entry, dict):
            continue
        key = normalize(entry.get("company"))
        if key:
            groups.setdefault(key, []).append(entry)
    out = []
    for key, items in groups.items():
        if len(items) < SUGGEST_MIN_POSTINGS:
            continue
        display = Counter(str(i.get("company")) for i in items).most_common(1)[0][0]
        if find_blocked(display, blocked):
            continue
        ages = [a for a in (_age(i, today) for i in items) if a is not None]
        median = statistics.median(ages) if ages else None
        reposts = sum(1 for i in items if i.get("reposted") is True)
        stale = median is not None and median > SUGGEST_MEDIAN_AGE_DAYS
        many_reposts = reposts >= SUGGEST_MIN_REPOSTS and reposts / len(items) >= SUGGEST_REPOST_SHARE
        if stale or many_reposts:
            out.append({"company": display, "count": len(items), "median_age_days": median, "reposted": reposts,
                        "why": "vacantes muy viejas" if stale else "vacantes republicadas"})
    return sorted(out, key=lambda s: (-s["count"], s["company"]))


def count_matches(seen: dict, blocked) -> list:
    """Per blocked entry: how many postings match, by status."""
    rows = []
    for b in blocked:
        by_status: Counter = Counter()
        companies: Counter = Counter()
        for e in seen.values():
            if isinstance(e, dict) and find_blocked(e.get("company"), [b]):
                by_status[str(e.get("status"))] += 1
                companies[str(e.get("company"))] += 1
        rows.append({"name": b["name"], "total": sum(by_status.values()), "by_status": dict(by_status), "companies": dict(companies)})
    return rows


def _main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("suggest", "count"):
        p = sub.add_parser(name)
        p.add_argument("--state", type=Path, default=Path(__file__).resolve().parent.parent / "job_scraper" / "seen_jobs.json")
        p.add_argument("--today", type=date.fromisoformat, default=date.today())
    args = ap.parse_args()
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import profile_config

    blocked = profile_config.load()["blocked_companies"]
    seen = json.loads(args.state.read_text(encoding="utf-8"))["seen"]
    out = suggestions(seen, blocked, args.today) if args.cmd == "suggest" else count_matches(seen, blocked)
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(_main())
