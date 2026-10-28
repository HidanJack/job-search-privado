#!/usr/bin/env python3
"""Per-user numeric/keyword profile, read from the gitignored `profile_config.json`.

Everything personal that the deterministic tools need (years of experience,
salary figures, stack keywords) lives in that one file at the repo root, never
in code. Missing file, malformed JSON or invalid individual values fall back to
the neutral DEFAULTS below, key by key, so no tool ever fails because of it.

The file location can be overridden with JOB_SEARCH_PROFILE_CONFIG (used by the
test-suite so results never depend on the real profile).
"""
import copy
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import company_blocklist  # noqa: E402  (blocked_companies validation)
import language_levels  # noqa: E402  (CEFR parsing and language codes shared with the language gate)

ROOT = Path(__file__).resolve().parent.parent
ENV_VAR = "JOB_SEARCH_PROFILE_CONFIG"
CONFIG_PATH = ROOT / "profile_config.json"

# Neutral starter families for the portal sweep when the profile has none (the
# onboarding flow replaces them with the user's own). English + Spanish.
DEFAULT_FAMILIES: list = [
    {"name": "Software / backend", "queries": [
        {"text": "software engineer", "lang": "en"}, {"text": "software developer", "lang": "en"},
        {"text": "backend developer", "lang": "en"}, {"text": "desarrollador de software", "lang": "es"},
        {"text": "desarrollador backend", "lang": "es"}]},
    {"name": "Frontend / full stack", "queries": [
        {"text": "frontend developer", "lang": "en"}, {"text": "full stack developer", "lang": "en"},
        {"text": "desarrollador frontend", "lang": "es"}, {"text": "desarrollador full stack", "lang": "es"}]},
    {"name": "Data", "queries": [
        {"text": "data engineer", "lang": "en"}, {"text": "data analyst", "lang": "en"},
        {"text": "ingeniero de datos", "lang": "es"}, {"text": "analista de datos", "lang": "es"}]},
    {"name": "DevOps / QA", "queries": [
        {"text": "devops engineer", "lang": "en"}, {"text": "qa engineer", "lang": "en"},
        {"text": "ingeniero devops", "lang": "es"}, {"text": "analista QA", "lang": "es"}]},
]

DEFAULTS: dict = {
    "name": "",                       # shown in the UI header; empty = profile not filled in yet
    "candidate_years": 3,             # verifiable professional years (risk scoring)
    "years_tolerance": 2,             # asks up to candidate_years + tolerance cost no risk
    "current_salary_mxn": 20000,      # monthly MXN; at/below it a job scores 0 on salary
    "salary_floor_mxn": 30000,        # monthly MXN you would accept (default search floor)
    "spoken_english": False,          # legacy switch; derived from `languages` when those are declared
    "prefilter": {
        # Title words that rescue a job from the "other stack" exclusions below.
        "skill_keep": ["python", "data", "ai", "ml", "llm", "typescript", "react", "node", "automation"],
        # Role families you do not work on: [{"words": [...], "label": "SAP"}]
        "stack_only": [
            {"words": ["sap", "abap"], "label": "SAP"},
            {"words": ["salesforce"], "label": "Salesforce"},
            {"words": ["servicenow"], "label": "ServiceNow"},
            {"words": ["workday"], "label": "Workday"},
            {"words": ["netsuite"], "label": "NetSuite"},
            {"words": ["mainframe", "cobol"], "label": "Mainframe/COBOL"},
        ],
        # Your stack named in a job title: [{"words": [...], "points": 10}] (each hit counts once, capped).
        "stack_points": [
            {"words": ["python"], "points": 12},
            {"words": ["backend", "back end", "back-end", "api"], "points": 6},
            {"words": ["full stack", "fullstack", "full-stack"], "points": 10},
            {"words": ["typescript", "react", "node", "nodejs"], "points": 6},
            {"words": ["docker", "kubernetes", "aws", "sql", "postgres"], "points": 4},
            {"words": ["ai", "ml", "llm", "machine learning", "genai"], "points": 8},
            {"words": ["data engineer", "etl", "data pipeline"], "points": 8},
        ],
        "stack_cap": 28,              # max points the stack hits can add together
        # Stacks/gigs that are not yours: kept but demoted by `points` (negative).
        "off_stack": {"words": [], "points": -8},
        "spanish_title_bonus": 6,     # points for a Spanish-language title (0 if you do not care)
    },
    # Languages you work in: {"language", "code" (ISO 639-1, derived), "read", "write", "speak"} with CEFR
    # (A1-C2) or "native" per skill. Drives the language gate, the opportunity/risk language terms, the
    # prefilter's "cannot read it" rule and the sweep's language-advantage queries. [] = not declared:
    # Spanish native + English B2/B2 with speak B2 (spoken_english true) or A2 (false) are assumed.
    "languages": [],
    # Companies you never want to see: [{"name", "aliases": [], "reason", "added": "YYYY-MM-DD"}].
    # The prefilter excludes their pending postings (recoverable) and the dashboard hides the ranked ones.
    "blocked_companies": [],
    # Portal sweep and Indeed step: role families with their queries (see _families).
    "search": {"families": DEFAULT_FAMILIES},
    "skills": {
        # Skill ids (ui/lib/skills.ts catalog) sampled for "Cuánto pagan tus habilidades".
        "selected": ["python", "kubernetes", "llm", "rag", "ai_engineer", "data_engineer", "etl", "fastapi", "qa_automation"],
        "combo_partners": ["llm", "rag", "kubernetes"],
        "primary": "python",
    },
}


def _is_int(v, lo=None, hi=None) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and (lo is None or v >= lo) and (hi is None or v <= hi)


def _is_words(v) -> bool:
    return isinstance(v, list) and bool(v) and all(isinstance(w, str) and w.strip() for w in v)


def _is_str_list(v) -> bool:
    return isinstance(v, list) and all(isinstance(w, str) and w.strip() for w in v)


def _entries(v, key: str, kind: str):
    """Valid {"words": [...], key: ...} entries, or None when v is not a usable list."""
    if not isinstance(v, list):
        return None
    out = []
    for item in v:
        if not isinstance(item, dict) or not _is_words(item.get("words")):
            continue
        extra = item.get(key)
        if kind == "int" and not _is_int(extra, -100, 100):
            continue
        if kind == "str" and not (isinstance(extra, str) and extra.strip()):
            continue
        out.append({"words": list(item["words"]), key: extra})
    return out


def _off_stack(v):
    if isinstance(v, dict) and _is_str_list(v.get("words")) and _is_int(v.get("points"), -100, 0):
        return {"words": list(v["words"]), "points": v["points"]}
    return None


CEFR_LEVELS = {"A1", "A2", "B1", "B2", "C1", "C2", "native"}
_LANG_CODE = re.compile(r"^[a-z]{2,3}$")


def _query_text(v):
    """A query string that is safe as a CLI argument (never a flag), or None."""
    if not isinstance(v, str):
        return None
    t = " ".join(v.split())
    return t if t and len(t) <= 80 and not t.startswith("-") else None


def _families(v):
    """Valid families, or None when nothing usable (caller keeps the defaults)."""
    if not isinstance(v, list):
        return None
    out = []
    for item in v:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 80:
            continue
        queries = []
        for q in item.get("queries") if isinstance(item.get("queries"), list) else []:
            text = _query_text(q.get("text")) if isinstance(q, dict) else None
            lang = q.get("lang") if isinstance(q, dict) else None
            if text and isinstance(lang, str) and _LANG_CODE.match(lang.strip().lower()):
                queries.append({"text": text, "lang": lang.strip().lower()})
        indeed = [t for t in (_query_text(x) for x in (item.get("indeed") if isinstance(item.get("indeed"), list) else [])) if t]
        if not queries and not indeed:
            continue
        fam = {"name": name.strip(), "queries": queries}
        if indeed:
            fam["indeed"] = indeed
        if item.get("broad") is True:
            fam["broad"] = True
        if item.get("discovered") is True:  # added from /discover: kept so the dashboard can tell where it came from
            fam["discovered"] = True
            sid = item.get("source_path_id")
            if isinstance(sid, str) and re.match(r"^[a-z0-9][a-z0-9-]{0,48}$", sid):
                fam["source_path_id"] = sid
        out.append(fam)
    return out or None


def _languages(v):
    if not isinstance(v, list):
        return None
    out = []
    for item in v:
        if not isinstance(item, dict) or not isinstance(item.get("language"), str) or not item["language"].strip():
            continue
        entry = {"language": item["language"].strip()}
        code = language_levels.language_code(entry["language"])
        if code:
            entry["code"] = code
        for k in ("read", "write", "speak"):
            lvl = item.get(k)
            lvl = lvl.strip() if isinstance(lvl, str) else lvl
            lvl = "native" if isinstance(lvl, str) and lvl.lower() == "native" else (lvl.upper() if isinstance(lvl, str) else lvl)
            entry[k] = lvl if lvl in CEFR_LEVELS else None
        out.append(entry)
    return out


def _apply(cfg: dict, raw: dict) -> None:
    if isinstance(raw.get("name"), str):
        cfg["name"] = raw["name"].strip()
    for key, lo, hi in (("candidate_years", 0, 60), ("years_tolerance", 0, 30),
                        ("current_salary_mxn", 1, 1_000_000), ("salary_floor_mxn", 1, 1_000_000)):
        if _is_int(raw.get(key), lo, hi):
            cfg[key] = raw[key]
    if isinstance(raw.get("spoken_english"), bool):
        cfg["spoken_english"] = raw["spoken_english"]

    pre = raw.get("prefilter")
    if isinstance(pre, dict):
        target = cfg["prefilter"]
        if _is_str_list(pre.get("skill_keep")):
            target["skill_keep"] = list(pre["skill_keep"])
        for key, field, kind in (("stack_only", "label", "str"), ("stack_points", "points", "int")):
            got = _entries(pre.get(key), field, kind)
            if got:
                target[key] = got
        if _is_int(pre.get("stack_cap"), 0, 100):
            target["stack_cap"] = pre["stack_cap"]
        if _is_int(pre.get("spanish_title_bonus"), 0, 30):
            target["spanish_title_bonus"] = pre["spanish_title_bonus"]
        off = _off_stack(pre.get("off_stack"))
        if off is not None:
            target["off_stack"] = off

    langs = _languages(raw.get("languages"))
    if langs is not None:
        cfg["languages"] = langs
        if langs and not isinstance(raw.get("spoken_english"), bool):
            # the legacy flag follows the declared English speaking level
            cfg["spoken_english"] = language_levels.speaks(language_levels.user_levels(cfg), "en", language_levels.SPEAK_COMFORTABLE)
    if "blocked_companies" in raw:
        cfg["blocked_companies"] = company_blocklist.parse_entries(raw["blocked_companies"])
    search = raw.get("search")
    if isinstance(search, dict):
        fams = _families(search.get("families"))
        if fams:
            cfg["search"]["families"] = fams

    skills = raw.get("skills")
    if isinstance(skills, dict):
        target = cfg["skills"]
        for key in ("selected", "combo_partners"):
            if _is_str_list(skills.get(key)):
                target[key] = list(skills[key])
        if isinstance(skills.get("primary"), str) and skills["primary"].strip():
            target["primary"] = skills["primary"].strip()


def resolve_path(path=None) -> Path:
    if path is not None:
        return Path(path)
    return Path(os.environ.get(ENV_VAR) or CONFIG_PATH)


def load(path=None) -> dict:
    """The profile merged over DEFAULTS; never raises."""
    cfg = copy.deepcopy(DEFAULTS)
    try:
        raw = json.loads(resolve_path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return cfg
    if isinstance(raw, dict):
        _apply(cfg, raw)
    return cfg


def levels(cfg=None) -> dict:
    """{code: {"read","write","speak"}} of the loaded (or given) profile; see language_levels."""
    return language_levels.user_levels(load() if cfg is None else cfg)


def is_filled(cfg: dict) -> bool:
    """True once the user has put their own name in the file."""
    return bool(cfg.get("name"))


def indeed_queries(cfg: dict, broad: bool = False) -> list:
    """[{"family", "queries"}] of Indeed search strings from `search.families`.

    A family's explicit `indeed` list wins; otherwise its Spanish queries followed by
    its English ones (Indeed MX is mostly Spanish; other languages are not searched).
    Families flagged `broad` are included only when `broad=True`. Case-insensitive de-dupe.
    Explicit mode: when ANY family lists `indeed` strings, only those families are used
    (the others exist for the portal sweep only).
    """
    out = []
    families = cfg["search"]["families"]
    explicit = any(f.get("indeed") for f in families)
    for fam in families:
        if fam.get("broad") and not broad:
            continue
        if explicit and not fam.get("indeed"):
            continue
        if fam.get("indeed"):
            raw = fam["indeed"]
        else:
            raw = [q["text"] for lang in ("es", "en") for q in fam["queries"] if q["lang"] == lang]
        seen, texts = set(), []
        for t in raw:
            if t.lower() not in seen:
                seen.add(t.lower())
                texts.append(t)
        if texts:
            out.append({"family": fam["name"], "queries": texts})
    return out


def main(argv=None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="Inspect the per-user profile configuration.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    q = sub.add_parser("queries", help="print the search strings of a portal derived from search.families")
    q.add_argument("--portal", required=True, choices=["indeed"])
    q.add_argument("--broad", action="store_true", help="also include the families flagged broad")
    q.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    for stream in (sys.stdout,):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            reconfigure(encoding="utf-8")
    data = indeed_queries(load(), broad=args.broad)
    if args.json:
        print(json.dumps(data, ensure_ascii=False))
    else:
        for fam in data:
            print(f"# {fam['family']}")
            print("\n".join(fam["queries"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
