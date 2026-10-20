#!/usr/bin/env python3
"""Deterministic (LLM-free) prefilter for unranked jobs.

The sweep can add hundreds of postings at once and `/rank` is slow and costs
LLM usage per job. This scores every `new` job from the fields the scraper
already stored (title, company, location, portal, posted_date, fit, salary
when present) against Luis's skills and role families, and:

  * marks clearly off-target jobs `prefiltered_out` with a short Spanish
    reason (SAP/Murex/Java-only/.NET-only/mobile-only/sales/marketing/HR/
    accounting titles, Staff/Principal/Director/Head seniority, Portuguese
    postings, postings restricted to another country). They are never deleted
    and never sent to /rank; `recover` puts one back in the pending pool.
  * stores `prefilter_score` (0-100) on the rest (the handcrafted heuristic, blended 50/50
    with tools/learned_score.py when ui/state/learned_model.json exists and is active,
    plus `prefilter_why`), which `rank_state.py
    candidates` uses to hand /rank the best N first.

Rules are intentionally conservative: when in doubt a job is kept and merely
scores low, because a false negative (a good job discarded) costs more than
one extra LLM call. Tech-stack exclusions are overridden by a positive skill
keyword in the title (`SAP` + `Python` stays).

Usage:
  python3 tools/prefilter.py run [--write] [--state PATH]
  python3 tools/prefilter.py recover KEY [--state PATH]
  python3 tools/prefilter.py evaluate --title T [--company C] [--location L]
"""
import argparse
import json
import re
import sys
import unicodedata
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / "job_scraper" / "seen_jobs.json"
SETTINGS = ROOT / "ui" / "state" / "settings.json"
MODEL = ROOT / "ui" / "state" / "learned_model.json"

OUT_STATUS = "prefiltered_out"
DEFAULT_RANK_BATCH = 10
# Deterministic gate in front of the LLM: `new` jobs scoring below this are never
# sent to /rank automatically (55 keeps the plausible 55-60 band, e.g. full stack / DevOps titles).
DEFAULT_MIN_PREFILTER_SCORE = 55
DEFAULT_MIN_SALARY = 35000
DEFAULT_MAX_DAYS = 7
CURRENT_SALARY = 21000


def load_search_settings(path: Path = SETTINGS) -> dict:
    """ui/state/settings.json["search"] merged over the same defaults the UI uses."""
    out = {
        "rankBatch": DEFAULT_RANK_BATCH,
        "minPrefilterScore": DEFAULT_MIN_PREFILTER_SCORE,
        "minSalaryMxn": DEFAULT_MIN_SALARY,
        "maxDays": DEFAULT_MAX_DAYS,
        "currentSalary": CURRENT_SALARY,
    }
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return out
    if not isinstance(doc, dict):
        return out
    search = doc.get("search") if isinstance(doc.get("search"), dict) else {}
    for key in ("rankBatch", "minSalaryMxn", "maxDays"):
        value = search.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            out[key] = value
    gate = search.get("minPrefilterScore")
    if isinstance(gate, int) and not isinstance(gate, bool) and 0 <= gate <= 100:
        out["minPrefilterScore"] = gate
    current = doc.get("currentSalary")
    if isinstance(current, int) and not isinstance(current, bool) and current > 0:
        out["currentSalary"] = current
    return out


def fold(text) -> str:
    """Lowercase and strip accents so "diseñador"/"inglés" match plain rules."""
    text = unicodedata.normalize("NFKD", str(text or "").lower())
    return "".join(c for c in text if not unicodedata.combining(c))


def rx(*words: str) -> "re.Pattern":
    return re.compile(r"(?<![a-z0-9])(?:" + "|".join(words) + r")(?![a-z0-9])")


# ---- exclusion rules (title based) -----------------------------------------
# A positive skill keyword in the title overrides STACK_ONLY / MOBILE rules.
SKILL_KEEP = rx(
    "python", "data", "datos", "ai", "ia", "ml", "llm", "etl", "machine learning",
    "typescript", "react", "node", "nodejs", "rust", "fastapi", "django", "flask",
    "automation", "automatizacion", "rpa",
)
# Engineering-role words: keep a "Marketing Technology Engineer" out of the
# function-based exclusions.
ENGINEER_WORDS = rx(
    "engineer", "engineering", "developer", "programmer", "ingeniero", "ingeniera",
    "desarrollador", "desarrolladora", "programador", "data scientist", "devops", "sre",
)
SENIORITY_OUT = rx("staff", "principal", "director", "head", "vp", "vice president", "chief", "cto", "distinguished")
SENIORITY_LABEL = {
    "staff": "Staff", "principal": "Principal", "director": "Director", "head": "Head",
    "vp": "VP", "vice president": "VP", "chief": "Chief", "cto": "CTO", "distinguished": "Distinguished",
}
# (pattern, label) - roles on a stack Luis does not work on.
STACK_ONLY = [
    (rx("sap", "abap"), "SAP"),
    (rx("murex"), "Murex"),
    (rx("salesforce"), "Salesforce"),
    (rx("servicenow"), "ServiceNow"),
    (rx("workday"), "Workday"),
    (rx("netsuite"), "NetSuite"),
    (rx("concur"), "Concur"),
    (rx("peoplesoft", "oracle ebs", "oracle fusion"), "Oracle ERP"),
    (rx("dynamics 365", "dynamics crm"), "Dynamics"),
    (rx("mainframe", "cobol"), "Mainframe/COBOL"),
    (rx("java"), "Java"),
    (rx("net", "dotnet", "c#", "asp net", "csharp"), ".NET"),
    (rx("php", "laravel"), "PHP"),
    (rx("ruby", "rails"), "Ruby"),
    (rx("c\\+\\+", "embedded", "firmware"), "C++/embebido"),
]
MOBILE = (rx("ios", "android", "swift", "kotlin", "mobile", "movil"), "móvil")
MOBILE_KEEP = rx("react native", "flutter")
# (pattern, Spanish label) - business functions that are not engineering.
FUNCTION_OUT = [
    (rx("growth", "seo", "sem", "brand", "publicidad"), "marketing"),
    (rx("recruiter", "recruiting", "talent acquisition", "hr", "human resources", "recursos humanos", "people partner", "reclutador", "reclutadora", "compensation"), "recursos humanos"),
    (rx("accountant", "accounting", "bookkeeper", "contador", "contadora", "contable", "payroll", "nomina", "billing", "cobranza", "tax"), "contabilidad"),
    (rx("customer success", "customer support", "customer service", "call center", "contact center", "agente", "agent", "appointment setter", "atencion a clientes"), "atención a clientes"),
    (rx("project manager", "program manager", "product manager", "scrum master", "producto manager"), "gestión de proyectos/producto"),
    (rx("designer", "disenador", "disenadora", "vfx", "animator", "illustrator", "video editor", "compositor", "cad"), "diseño"),
    (rx("community manager", "content writer", "copywriter", "content creator", "content designer", "translator", "traductor"), "contenido"),
    (rx("legal", "attorney", "lawyer", "abogado", "counsel", "paralegal"), "legal"),
    (rx("teacher", "tutor", "profesor", "education", "instructor", "nurse", "enfermera", "healthcare"), "educación/salud"),
    (rx("assistant", "asistente", "secretary", "receptionist"), "asistencia administrativa"),
]
# Clearly non-tech functions. Only an engineering word (never a mere skill word such
# as "AI" or "automation") rescues them: "Account Executive - Industrial AI" stays out.
HARD_OUT = [
    (rx("sales", "ventas", "vendedor", "vendedora", "account executive", "account manager", "business development", "sdr", "bdr", "major ae", "deal desk"), "ventas"),
    (rx("marketing", "paid social", "influencer", "influencers"), "marketing"),
    (rx("ceo", "coo", "cfo", "cpo", "co-founder", "cofounder", "co founder"), "dirección ejecutiva"),
    (rx("logistics", "logistica", "planner", "buyer", "procurement", "warehouse", "supply chain", "field service"), "logística/operaciones"),
    (rx("accounts payable", "accounts receivable", "financial", "finance", "finanzas", "financiero", "financiera"), "finanzas/administración"),
    (rx("interpreter", "interpreters", "interprete", "interpretes", "linguist", "linguistic"), "idiomas/interpretación"),
    (rx("patient", "clinical", "regulatory affairs", "mental health", "medical", "pharma", "paciente"), "salud"),
    (rx("estimator", "construction", "construccion"), "construcción"),
    (rx("learning", "talent", "hris", "people ops", "onboarding"), "recursos humanos/capacitación"),
    (rx("customer care", "customer operations", "resident support", "intake", "immigration", "inmigracion"), "atención a clientes"),
    (rx("rater", "data entry", "annotator", "annotation", "ai trainer", "video collection", "captura de datos"), "etiquetado/captura de datos"),
    (rx("coordinator", "coordinador", "coordinadora", "event"), "coordinación administrativa"),
]
# Engineering that is not software (mechanical, electrical...), unless software is named.
NON_SW_ENGINEERING = rx(
    "mechanical", "electrical", "instrumentation", "aerodynamics", "hardware", "civil", "chemical",
    "structural", "mechatronics", "package design", "electronics", "electronica", "mecanico", "electrico",
)
SOFTWARE_WORDS = rx(
    "software", "python", "developer", "desarrollador", "desarrolladora", "programador", "backend",
    "frontend", "full stack", "fullstack", "machine learning", "llm", "firmware",
)
PORTUGUESE = rx(
    "engenheiro", "engenheira", "desenvolvedor", "desenvolvedora", "vaga", "estagio",
    "qualidade", "pessoa", "analista de qualidade", "cientista", "desenvolvimento", "engenharia", "dados",
)
# Countries/regions that exclude a Mexico-based candidate when they are the
# only place named. Anything unrecognised is kept.
FOREIGN_PLACES = [
    "brazil", "brasil", "argentina", "venezuela", "colombia", "chile", "peru", "uruguay",
    "ecuador", "bolivia", "paraguay", "costa rica", "panama", "guatemala", "dominican",
    "india", "pakistan", "philippines", "indonesia", "vietnam", "china", "japan", "singapore",
    "australia", "new zealand", "europe", "emea", "uk", "united kingdom", "ireland", "germany",
    "france", "spain", "portugal", "italy", "poland", "romania", "netherlands", "nigeria",
    "kenya", "south africa", "egypt", "turkey", "ukraine", "canada", "usa", "united states",
    "us only", "u.s.",
]
TRUNCATED_LOCATION = 190
LOCATION_OK = ("mexico", "worldwide", "anywhere", "latam", "latin america", "americas", "global", "north america", "international")


REGION_OPEN = re.compile(
    r"(?<![a-z])(latam|latin america|latinoamerica|america latina|south america|sudamerica|mexico|worldwide|anywhere|global)(?![a-z])")
OPEN_TEXT_FIELDS = ("title", "fit", "description", "summary", "notes")


def region_open(entry: dict) -> bool:
    """True when a text field other than location says the role is open to LatAm/anywhere."""
    return any(isinstance(entry.get(k), str) and REGION_OPEN.search(fold(entry[k])) for k in OPEN_TEXT_FIELDS)


def location_restriction(location) -> str | None:
    """Foreign place name when the posting is limited to it, else None."""
    loc = fold(location)
    # The sweep stores at most 200 characters: a cut-off list may hide Mexico.
    if len(loc) >= TRUNCATED_LOCATION or not loc or loc == "none" or any(t in loc for t in LOCATION_OK):
        return None
    for place in FOREIGN_PLACES:
        if re.search(r"(?<![a-z])" + re.escape(place) + r"(?![a-z])", loc):
            return place.title() if len(place) > 3 else place.upper()
    return None


def exclusion(entry: dict) -> str | None:
    """Spanish reason the job is clearly off-target, or None to keep it."""
    title = fold(entry.get("title"))
    keep_skill = bool(SKILL_KEEP.search(title))
    is_engineer = bool(ENGINEER_WORDS.search(title))

    m = SENIORITY_OUT.search(title)
    if m:
        label = SENIORITY_LABEL.get(m.group(0), m.group(0).title())
        return f"Nivel {label}: muy por encima de tu experiencia"
    if PORTUGUESE.search(title):
        return "Anuncio en portugués"
    for pattern, label in STACK_ONLY:
        if pattern.search(title) and not keep_skill:
            return f"Puesto centrado en {label}, fuera de tu stack"
    pattern, label = MOBILE
    if pattern.search(title) and not MOBILE_KEEP.search(title) and not keep_skill:
        return "Puesto solo de desarrollo móvil (iOS/Android)"
    for pattern, label in HARD_OUT:
        if pattern.search(title) and not is_engineer:
            return f"Puesto de {label}, no es desarrollo ni datos"
    if NON_SW_ENGINEERING.search(title) and not SOFTWARE_WORDS.search(title):
        return "Ingeniería ajena al software (mecánica/eléctrica/hardware)"
    for pattern, label in FUNCTION_OUT:
        if pattern.search(title) and not is_engineer and not keep_skill:
            return f"Puesto de {label}, no es desarrollo ni datos"
    place = None if region_open(entry) else location_restriction(entry.get("location"))
    if place:
        return f"Solo para residentes de {place}"
    return None


# ---- scoring (kept jobs) -----------------------------------------------------
# Real tech fits land 60-100, plausible ones 45-60 and noise below 40. A title with
# no tech signal at all is capped at NON_TECH_CAP whatever its location or recency.
BASE_SCORE = 15
NON_TECH_CAP = 30
# Title names a software/data/AI/infra role: the strong "this is tech" signal.
TECH_STRONG = rx(
    "software", "developer", "desarrollador", "desarrolladora", "programador", "programmer",
    "backend", "back end", "back-end", "frontend", "front end", "front-end", "full stack", "fullstack",
    "full-stack", "data engineer", "data engineering", "ingeniero de datos", "ingeniera de datos",
    "ingenieria de datos", "big data", "etl", "python", "machine learning", "ml", "llm",
    "inteligencia artificial", "genai", "nlp", "devops", "sre", "site reliability", "sdet", "platform",
    "golang", "rust", "react", "typescript", "node", "nodejs", "ingeniero de software", "ingeniera de software",
    "swe", "dataops", "mlops",
)
# Generic technical title: weaker signal, still not noise.
TECH_WEAK = rx(
    "engineer", "engineering", "ingeniero", "ingeniera", "data", "datos", "analytics", "qa", "quality assurance",
    "tester", "automation", "automatizacion", "rpa", "cloud", "aws", "azure", "kubernetes", "scientist",
    "bi", "business intelligence", "architect", "arquitecto", "arquitecta", "sysadmin", "dba", "database",
    "technical", "tecnico", "cyber", "cybersecurity", "seguridad",
)
# "AI"/"IA" alone is not enough ("Creative Producer (AI-Driven)"): it needs an engineering role beside it.
AI_WORD = rx("ai", "ia")
AI_STACK = rx("ai", "ia", "ml", "llm", "rag", "agents", "agentic", "claude", "machine learning", "inteligencia artificial", "genai")
AI_ROLE = rx(
    "engineer", "engineering", "developer", "programmer", "ingeniero", "ingeniera", "desarrollador",
    "desarrolladora", "programador", "scientist", "architect", "arquitecto", "arquitecta", "devops", "sre",
)
AI_PAIRED_BONUS = 4  # AI/LLM/agents word beside an engineer/developer word: 10 -> 14 points
TECH_STRONG_POINTS = 38
TECH_WEAK_POINTS = 24
# (pattern, points): his stack named in the title. Every hit counts once, capped overall.
STACK_POINTS = [
    (rx("python"), 16),
    (rx("data engineer", "ingeniero de datos", "ingeniera de datos", "etl", "data pipeline", "dwh", "big data", "spark", "databricks", "snowflake", "airflow", "dbt", "kafka"), 10),
    (rx("ai", "ia", "ml", "llm", "rag", "agents", "agentic", "claude", "machine learning", "inteligencia artificial", "genai", "nlp", "copilot"), 10),
    (rx("backend", "back end", "back-end", "api", "microservices", "microservicios"), 6),
    (rx("fastapi", "django", "flask", "pandas", "polars", "ocr", "pytest"), 6),
    (rx("kubernetes", "k8s", "docker", "aws", "sql", "postgres", "postgresql", "terraform"), 4),
    (rx("typescript", "react", "node", "nodejs"), 4),
    (rx("full stack", "fullstack", "full-stack"), 14),
    (rx("rust"), 5),
    (rx("rpa", "automation", "automatizacion", "automate"), 4),
    (rx("data analyst", "analista de datos", "bi analyst", "business intelligence", "data scientist", "analytics"), 2),
    (rx("devops", "sre", "cloud", "platform", "azure", "qa", "sdet"), 3),
]
STACK_CAP = 28
SPANISH_TITLE_WORDS = rx(
    "desarrollador", "desarrolladora", "ingeniero", "ingeniera", "analista", "datos",
    "remoto", "sr", "ssr", "especialista", "arquitecto", "programador", "inteligencia",
)
PENALTIES = [
    (rx("manager", "gerente", "jefe", "lider"), -10),
    (rx("lead"), -2),
    (rx("architect", "arquitecto", "arquitecta"), -6),
    (rx("senior", "sr"), -1),
    (rx("intern", "internship", "trainee", "practicante", "becario"), -15),
    # Stacks or gigs that are not his: kept (a skill word may still redeem them) but demoted.
    (rx("golang", "go", "scala", "elixir", "game", "unity", "trading", "low latency", "low-latency", "pega", "hyland", "looker", "powercampus", "salesforce"), -8),
    (rx("security", "pentest", "penetration", "cybersecurity", "ciberseguridad"), -6),
    (rx("react native", "mobile", "movil"), -6),
    (rx("contributor", "ai coding tasks", "freelance", "volunteer", "ambassador", "advisor", "founding"), -8),
]
JUNIOR = rx("junior", "jr", "entry level", "associate")
LOCATION_POINTS = (("mexico", 6), ("latam", 6), ("latin america", 6), ("worldwide", 6), ("anywhere", 6), ("americas", 5), ("global", 3))
FIT_POINTS = {"high": 12, "medium": 0, "low": -8}


def parse_date(value) -> date | None:
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def score(entry: dict, today: date, floor: int = DEFAULT_MIN_SALARY, current: int = CURRENT_SALARY) -> int:
    """0-100 relevance of a kept job; higher = send to /rank sooner."""
    title = fold(entry.get("title"))
    strong = bool(TECH_STRONG.search(title)) or bool(AI_WORD.search(title) and AI_ROLE.search(title))
    is_tech = strong or bool(TECH_WEAK.search(title))
    points = BASE_SCORE + (TECH_STRONG_POINTS if strong else TECH_WEAK_POINTS if is_tech else 0)
    stack = sum(value for pattern, value in STACK_POINTS if pattern.search(title))
    if AI_STACK.search(title) and AI_ROLE.search(title):
        stack += AI_PAIRED_BONUS
    points += min(STACK_CAP, stack)
    for pattern, value in PENALTIES:
        if pattern.search(title):
            points += value
    if JUNIOR.search(title):
        points += 3
    # Imported here: posting_language -> rank_state -> prefilter would be a cycle.
    import posting_language

    if SPANISH_TITLE_WORDS.search(title) or posting_language.detect_title(entry.get("title") or "") == "es":
        points += 6
    loc = fold(entry.get("location"))
    if loc:
        points += max((v for token, v in LOCATION_POINTS if token in loc), default=0)
        if loc.startswith("remote") or "remoto" in loc:
            points += 3
    points += FIT_POINTS.get(entry.get("fit"), 0)
    posted = parse_date(entry.get("posted_date"))
    if posted:
        age = max(0, (today - posted).days)
        points += 6 if age <= 2 else 4 if age <= 4 else 2 if age <= 7 else -5 if age > 30 else -2 if age > 14 else 0
    salary = entry.get("salary_mxn_month")
    if isinstance(salary, (int, float)) and not isinstance(salary, bool):
        points += 5 if salary >= floor else -10 if salary < current else 0
    if not is_tech:
        points = min(points, NON_TECH_CAP)
    return max(0, min(100, int(points)))


def evaluate(entry: dict, today: date, floor: int = DEFAULT_MIN_SALARY, current: int = CURRENT_SALARY) -> dict:
    reason = exclusion(entry)
    return {"score": score(entry, today, floor, current), "out": reason is not None, "reason": reason}


# ---- state -------------------------------------------------------------------
def apply_score(entry: dict, today: date, settings: dict, model: dict | None = None) -> int:
    """Store prefilter_score: handcrafted, or the 50/50 blend with the learned model when it is active."""
    hand = score(entry, today, settings["minSalaryMxn"], settings["currentSalary"])
    if not model or not model.get("active"):
        entry["prefilter_score"] = hand
        return hand
    import learned_score  # imported lazily: learned_score imports this module

    final, parts = learned_score.blended_score(model, entry, today, hand=hand)
    entry["prefilter_score"] = final
    entry["prefilter_hand_score"] = hand
    if "learned" in parts:
        entry["prefilter_learned_score"] = parts["learned"]
    why = learned_score.explain(model, entry)
    if why:
        entry["prefilter_why"] = why
    else:
        entry.pop("prefilter_why", None)
    return final


def prefilter_state(seen: dict, today: date, settings: dict, model: dict | None = None) -> dict:
    """Update `new` entries in place; returns counts. Recovered entries are kept."""
    kept = out = recovered = 0
    for entry in seen.values():
        if entry.get("status") != "new":
            continue
        if entry.get("prefilter_recovered"):
            apply_score(entry, today, settings, model)
            recovered += 1
            continue
        reason = exclusion(entry)
        apply_score(entry, today, settings, model)
        verdict = {"out": reason is not None, "reason": reason}
        if verdict["out"]:
            entry["status"] = OUT_STATUS
            entry["prefilter_reason"] = verdict["reason"]
            entry["prefilter_date"] = today.isoformat()
            out += 1
        else:
            kept += 1
    return {"kept": kept, "prefiltered_out": out, "recovered_kept": recovered}


def recover_entry(entry: dict) -> bool:
    if entry.get("status") != OUT_STATUS:
        return False
    entry["status"] = "new"
    entry["prefilter_recovered"] = True
    entry.pop("prefilter_reason", None)
    return True


def _load(path: Path) -> tuple[dict, dict]:
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        sys.exit(f"cannot read {path}: {exc}")
    seen = doc.get("seen") if isinstance(doc, dict) else None
    if not isinstance(seen, dict):
        sys.exit(f"{path} has no 'seen' object")
    return doc, seen


def _save(path: Path, doc: dict) -> None:
    tmp = Path(f"{path}.prefilter.tmp")
    tmp.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(path)


def cmd_run(args) -> int:
    doc, seen = _load(args.state)
    import learned_score

    model = learned_score.load_model(args.model)
    counts = prefilter_state(seen, args.today, load_search_settings(args.settings), model=model)
    if args.write:
        _save(args.state, doc)
    blend = bool(model and model.get("active"))
    print(json.dumps({**counts, "written": bool(args.write), "learned_blend": blend}, ensure_ascii=False))
    return 0


def cmd_recover(args) -> int:
    import learned_score

    doc, seen = _load(args.state)
    entry = seen.get(args.key)
    if entry is None or not recover_entry(entry):
        sys.exit(f"{args.key}: not a prefiltered_out entry")
    apply_score(entry, args.today, load_search_settings(args.settings), learned_score.load_model(args.model))
    _save(args.state, doc)
    print(json.dumps({"recovered": args.key}))
    return 0


def cmd_evaluate(args) -> int:
    entry = {"title": args.title, "company": args.company, "location": args.location}
    print(json.dumps(evaluate(entry, args.today), ensure_ascii=False))
    return 0


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--state", type=Path, default=STATE)
    common.add_argument("--settings", type=Path, default=SETTINGS)
    common.add_argument("--model", type=Path, default=MODEL, help="learned model (ui/state/learned_model.json); used when present")
    common.add_argument("--today", type=date.fromisoformat, default=date.today())
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser("run", parents=[common])
    run.add_argument("--write", action="store_true")
    run.set_defaults(func=cmd_run)
    rec = sub.add_parser("recover", parents=[common])
    rec.add_argument("key")
    rec.set_defaults(func=cmd_recover)
    ev = sub.add_parser("evaluate", parents=[common])
    ev.add_argument("--title", required=True)
    ev.add_argument("--company", default="")
    ev.add_argument("--location", default="")
    ev.set_defaults(func=cmd_evaluate)
    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
