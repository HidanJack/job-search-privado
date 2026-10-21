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
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_VAR = "JOB_SEARCH_PROFILE_CONFIG"
CONFIG_PATH = ROOT / "profile_config.json"

DEFAULTS: dict = {
    "name": "",                       # shown in the UI header; empty = profile not filled in yet
    "candidate_years": 3,             # verifiable professional years (risk scoring)
    "years_tolerance": 2,             # asks up to candidate_years + tolerance cost no risk
    "current_salary_mxn": 20000,      # monthly MXN; at/below it a job scores 0 on salary
    "salary_floor_mxn": 30000,        # monthly MXN you would accept (default search floor)
    "spoken_english": False,          # True = English postings are not penalised
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


def is_filled(cfg: dict) -> bool:
    """True once the user has put their own name in the file."""
    return bool(cfg.get("name"))
