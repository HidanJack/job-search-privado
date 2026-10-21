#!/usr/bin/env python3
"""Schema validation for the profile proposal that /onboard writes (ui/state/onboarding/proposal.json).

The proposal is produced by an LLM from untrusted text and later edited by the
user, and deterministic code (tools/onboarding_apply.py) turns it into files that
other prompts read. So it is validated strictly, here, in one place:

  validate(raw)        -> Result(proposal, errors, repairs, flagged)
  validate_text(text)  -> same, from a JSON string (a ```json fence is repaired)

* `errors`   [{"path","message"}] (Spanish): structural problems; nothing may be stored/applied.
* `repairs`  notes about harmless fixes (unknown keys dropped, whitespace trimmed...).
* `flagged`  paths of fields that look like instructions to an AI (posting_guard). The
             proposal is still returned and carries an automatic "⚠ Campo ..." warning;
             onboarding_apply refuses to write while any field is flagged.

Schema (version 1): see .claude/commands/onboard.md. Nullable strings may be null
(unknown); CEFR levels are A1-C2 or "native" and are never guessed by code.

CLI: python3 tools/onboarding_proposal.py validate --in FILE [--out FILE]
     prints {"ok","errors","repairs","flagged","proposal"}; exit 0 valid, 2 invalid.
"""
import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import posting_guard  # noqa: E402

VERSION = 1
AUTO_WARNING_PREFIX = "⚠ Campo "
CEFR = {"A1", "A2", "B1", "B2", "C1", "C2"}
REMOTE = {"remote", "hybrid", "onsite", "any"}

MAX_STR = 400
MAX_LONG = 1200
MAX_SUMMARY = 3000
MAX_QUERY = 80
MAX_EXPERIENCE, MAX_EDUCATION, MAX_SKILLS, MAX_LANGUAGES = 30, 15, 100, 15
MAX_FAMILIES, MAX_QUERIES, MAX_HIGHLIGHTS, MAX_LINKS = 12, 30, 20, 10
MAX_STACK, MAX_QUESTIONS, MAX_WARNINGS, MAX_ROLES = 60, 12, 30, 20

TOP_REQUIRED = ["version", "identity", "summary", "years_experience", "experience", "education", "skills",
                "languages", "targets", "search_families", "stack"]
TOP_KEYS = TOP_REQUIRED + ["questions", "warnings"]
CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
LANG = re.compile(r"^[a-z]{2,3}$")
QID = re.compile(r"^[a-z0-9_-]{1,40}$")
FENCE = re.compile(r"^\s*```(?:json)?\s*\n(.*?)\n\s*```\s*$", re.S)


@dataclass
class Result:
    proposal: dict = field(default_factory=dict)
    errors: list = field(default_factory=list)
    repairs: list = field(default_factory=list)
    flagged: list = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


class _V:
    def __init__(self):
        self.res = Result()

    def err(self, path: str, msg: str) -> None:
        self.res.errors.append({"path": path, "message": msg})

    def repair(self, msg: str) -> None:
        self.res.repairs.append(msg)

    # -- primitives ---------------------------------------------------------
    def obj(self, path, v, keys, required=()):
        """A dict restricted to `keys`; unknown keys are dropped and reported."""
        if not isinstance(v, dict):
            self.err(path, f"«{path}» debe ser un objeto.")
            return None
        for k in v:
            if k not in keys:
                self.repair(f"Se descartó el campo desconocido «{path + '.' if path else ''}{k}».")
        for k in required:
            if k not in v:
                self.err(f"{path}.{k}" if path else k, f"Falta «{path + '.' if path else ''}{k}».")
        return {k: v[k] for k in keys if k in v}

    def text(self, path, v, *, maxlen=MAX_STR, nullable=True, required=False):
        """Single-line cleaned string, or None."""
        if v is None:
            if required or not nullable:
                self.err(path, f"«{path}» es obligatorio.")
            return None
        if not isinstance(v, str):
            self.err(path, f"«{path}» debe ser texto.")
            return None
        s = CONTROL.sub("", v)
        s = posting_guard.clean_text(s)[0]
        s = re.sub(r"\s+", " ", s).strip()
        if not s:
            if required:
                self.err(path, f"«{path}» no puede estar vacío.")
                return None
            return None if nullable else ""
        if len(s) > maxlen:
            self.err(path, f"«{path}» es demasiado largo (máximo {maxlen} caracteres).")
            return None
        if posting_guard.scan(s, "")["instruction_like"]:
            self.res.flagged.append(path)
        return s

    def text_list(self, path, v, *, maxitems, maxlen=MAX_STR, validator=None):
        if not isinstance(v, list):
            self.err(path, f"«{path}» debe ser una lista.")
            return []
        if len(v) > maxitems:
            self.err(path, f"«{path}» tiene demasiados elementos (máximo {maxitems}).")
            return []
        out = []
        for i, item in enumerate(v):
            s = self.text(f"{path}[{i}]", item, maxlen=maxlen, nullable=False, required=True)
            if s is not None and validator and not validator(f"{path}[{i}]", s):
                continue
            if s:
                out.append(s)
        return out

    def boolean(self, path, v):
        if isinstance(v, bool):
            return v
        self.err(path, f"«{path}» debe ser true o false.")
        return False

    def cefr(self, path, v):
        if v is None:
            return None
        if isinstance(v, str):
            s = v.strip()
            if s.upper() in CEFR:
                return s.upper()
            if s.lower() == "native":
                return "native"
        self.err(path, f"«{path}» debe ser un nivel CEFR (A1-C2), «native» o null.")
        return None

    def items(self, path, v, maxitems):
        if not isinstance(v, list):
            self.err(path, f"«{path}» debe ser una lista.")
            return []
        if len(v) > maxitems:
            self.err(path, f"«{path}» tiene demasiados elementos (máximo {maxitems}).")
            return []
        return v


def _url(v: _V, path: str, s: str) -> bool:
    if not re.match(r"^https?://[^\s]+$", s, re.I):
        v.err(path, f"«{path}» debe ser una URL http(s).")
        return False
    return True


def _validate(raw) -> Result:
    v = _V()
    if not isinstance(raw, dict):
        v.err("", "La propuesta debe ser un objeto JSON.")
        return v.res
    top = v.obj("", raw, TOP_KEYS, TOP_REQUIRED)
    out: dict = {}
    if top is None:
        return v.res

    if raw.get("version") != VERSION or isinstance(raw.get("version"), bool):
        if "version" in raw:
            v.err("version", f"«version» debe ser {VERSION}.")
    out["version"] = VERSION

    # identity
    ident = top.get("identity")
    if "identity" in top:
        d = v.obj("identity", ident, ["name", "email", "phone", "location", "links"])
        if d is not None:
            email = v.text("identity.email", d.get("email"))
            if email and not EMAIL.match(email):
                v.err("identity.email", "«identity.email» no parece un correo válido.")
                email = None
            links_raw = d.get("links", [])
            links = v.text_list("identity.links", links_raw, maxitems=MAX_LINKS, maxlen=300,
                                validator=lambda p, s: _url(v, p, s))
            out["identity"] = {"name": v.text("identity.name", d.get("name")), "email": email,
                               "phone": v.text("identity.phone", d.get("phone"), maxlen=40),
                               "location": v.text("identity.location", d.get("location")), "links": links}

    if "summary" in top:
        out["summary"] = v.text("summary", top["summary"], maxlen=MAX_SUMMARY, nullable=False)

    if "years_experience" in top:
        d = v.obj("years_experience", top["years_experience"], ["value", "basis"])
        if d is not None:
            val = d.get("value")
            if val is not None and (isinstance(val, bool) or not isinstance(val, (int, float)) or not 0 <= val <= 60):
                v.err("years_experience.value", "«years_experience.value» debe ser un número entre 0 y 60 (o null).")
                val = None
            out["years_experience"] = {"value": val, "basis": v.text("years_experience.basis", d.get("basis"), maxlen=MAX_LONG)}

    if "experience" in top:
        rows = []
        for i, e in enumerate(v.items("experience", top["experience"], MAX_EXPERIENCE)):
            p = f"experience[{i}]"
            d = v.obj(p, e, ["company", "title", "start", "end", "highlights"])
            if d is None:
                continue
            row = {"company": v.text(f"{p}.company", d.get("company")), "title": v.text(f"{p}.title", d.get("title")),
                   "start": v.text(f"{p}.start", d.get("start"), maxlen=40), "end": v.text(f"{p}.end", d.get("end"), maxlen=40),
                   "highlights": v.text_list(f"{p}.highlights", d.get("highlights", []), maxitems=MAX_HIGHLIGHTS, maxlen=MAX_LONG)}
            if not row["company"] and not row["title"]:
                v.err(p, f"«{p}» necesita al menos empresa o puesto.")
            rows.append(row)
        out["experience"] = rows

    if "education" in top:
        rows = []
        for i, e in enumerate(v.items("education", top["education"], MAX_EDUCATION)):
            p = f"education[{i}]"
            d = v.obj(p, e, ["degree", "institution", "status", "start", "end"])
            if d is None:
                continue
            row = {k: v.text(f"{p}.{k}", d.get(k), maxlen=40 if k in ("start", "end") else MAX_STR)
                   for k in ("degree", "institution", "status", "start", "end")}
            if not row["degree"] and not row["institution"]:
                v.err(p, f"«{p}» necesita al menos título o institución.")
            rows.append(row)
        out["education"] = rows

    if "skills" in top:
        rows = []
        for i, s in enumerate(v.items("skills", top["skills"], MAX_SKILLS)):
            p = f"skills[{i}]"
            d = v.obj(p, s, ["name", "level", "evidence", "inferred"], ["name", "inferred"])
            if d is None:
                continue
            rows.append({"name": v.text(f"{p}.name", d.get("name"), maxlen=80, required=True),
                         "level": v.text(f"{p}.level", d.get("level"), maxlen=80),
                         "evidence": v.text(f"{p}.evidence", d.get("evidence"), maxlen=MAX_LONG),
                         "inferred": v.boolean(f"{p}.inferred", d.get("inferred"))})
        out["skills"] = rows

    if "languages" in top:
        rows = []
        for i, l in enumerate(v.items("languages", top["languages"], MAX_LANGUAGES)):
            p = f"languages[{i}]"
            d = v.obj(p, l, ["language", "read", "write", "speak", "inferred"], ["language", "inferred"])
            if d is None:
                continue
            rows.append({"language": v.text(f"{p}.language", d.get("language"), maxlen=60, required=True),
                         "read": v.cefr(f"{p}.read", d.get("read")), "write": v.cefr(f"{p}.write", d.get("write")),
                         "speak": v.cefr(f"{p}.speak", d.get("speak")),
                         "inferred": v.boolean(f"{p}.inferred", d.get("inferred"))})
        out["languages"] = rows

    if "targets" in top:
        d = v.obj("targets", top["targets"], ["roles", "remote", "location", "salary_floor_mxn"])
        if d is not None:
            remote = d.get("remote")
            if remote not in REMOTE:
                v.err("targets.remote", "«targets.remote» debe ser remote, hybrid, onsite o any.")
                remote = None
            floor = d.get("salary_floor_mxn")
            if floor is not None and (isinstance(floor, bool) or not isinstance(floor, int) or not 1 <= floor <= 1_000_000):
                v.err("targets.salary_floor_mxn", "«targets.salary_floor_mxn» debe ser un entero entre 1 y 1,000,000 (o null).")
                floor = None
            out["targets"] = {"roles": v.text_list("targets.roles", d.get("roles", []), maxitems=MAX_ROLES, maxlen=80),
                              "remote": remote, "location": v.text("targets.location", d.get("location")),
                              "salary_floor_mxn": floor}

    if "search_families" in top:
        rows = []
        for i, f in enumerate(v.items("search_families", top["search_families"], MAX_FAMILIES)):
            p = f"search_families[{i}]"
            d = v.obj(p, f, ["name", "queries", "inferred"], ["name", "queries", "inferred"])
            if d is None:
                continue
            queries = []
            for j, q in enumerate(v.items(f"{p}.queries", d.get("queries"), MAX_QUERIES)):
                qp = f"{p}.queries[{j}]"
                qd = v.obj(qp, q, ["text", "lang"], ["text", "lang"])
                if qd is None:
                    continue
                text = v.text(f"{qp}.text", qd.get("text"), maxlen=MAX_QUERY, required=True)
                if text and text.startswith("-"):
                    v.err(f"{qp}.text", f"«{qp}.text» no puede empezar con «-».")
                    text = None
                lang = qd.get("lang")
                lang = lang.strip().lower() if isinstance(lang, str) else lang
                if not isinstance(lang, str) or not LANG.match(lang):
                    v.err(f"{qp}.lang", f"«{qp}.lang» debe ser un código de idioma de 2 o 3 letras (en, es, de...).")
                    lang = None
                if text and lang:
                    queries.append({"text": text, "lang": lang})
            rows.append({"name": v.text(f"{p}.name", d.get("name"), maxlen=80, required=True), "queries": queries,
                         "inferred": v.boolean(f"{p}.inferred", d.get("inferred"))})
        out["search_families"] = rows

    if "stack" in top:
        d = v.obj("stack", top["stack"], ["strong", "secondary", "avoid"])
        if d is not None:
            out["stack"] = {k: v.text_list(f"stack.{k}", d.get(k, []), maxitems=MAX_STACK, maxlen=60)
                            for k in ("strong", "secondary", "avoid")}

    qs, seen = [], set()
    for i, q in enumerate(v.items("questions", top.get("questions", []), MAX_QUESTIONS)):
        p = f"questions[{i}]"
        d = v.obj(p, q, ["id", "text", "why"], ["id", "text"])
        if d is None:
            continue
        qid = v.text(f"{p}.id", d.get("id"), maxlen=40, required=True)
        if qid and (not QID.match(qid) or qid in seen):
            v.err(f"{p}.id", f"«{p}.id» debe ser único y usar solo minúsculas, números, «_» o «-».")
        seen.add(qid)
        qs.append({"id": qid, "text": v.text(f"{p}.text", d.get("text"), maxlen=MAX_LONG, required=True),
                   "why": v.text(f"{p}.why", d.get("why"), maxlen=MAX_LONG)})
    out["questions"] = qs

    manual = []
    for w in v.text_list("warnings", top.get("warnings", []), maxitems=MAX_WARNINGS, maxlen=MAX_LONG):
        if not w.startswith(AUTO_WARNING_PREFIX):  # automatic ones are recomputed below
            manual.append(w)
    auto = [f"{AUTO_WARNING_PREFIX}«{p}» parece contener instrucciones dirigidas a una IA; edítalo o bórralo antes de confirmar."
            for p in dict.fromkeys(v.res.flagged)]
    out["warnings"] = manual + auto

    v.res.flagged = list(dict.fromkeys(v.res.flagged))
    v.res.proposal = out
    return v.res


def validate(raw) -> Result:
    return _validate(raw)


def validate_text(text: str) -> Result:
    body = text
    fence = FENCE.match(text or "")
    repairs = []
    if fence:
        body = fence.group(1)
        repairs.append("Se quitó el bloque de código que envolvía el JSON.")
    try:
        raw = json.loads(body)
    except (ValueError, TypeError):
        res = Result()
        res.errors.append({"path": "", "message": "El archivo no es JSON válido."})
        return res
    res = _validate(raw)
    res.repairs = repairs + res.repairs
    return res


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    val = sub.add_parser("validate")
    val.add_argument("--in", dest="infile", type=Path, required=True)
    val.add_argument("--out", type=Path, help="write the normalised proposal here when valid")
    args = ap.parse_args(argv)
    try:
        res = validate_text(args.infile.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError):
        res = Result()
        res.errors.append({"path": "", "message": "No se pudo leer la propuesta."})
    if res.ok and args.out:
        args.out.write_text(json.dumps(res.proposal, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    sys.stdout.write(json.dumps({"ok": res.ok, "errors": res.errors, "repairs": res.repairs, "flagged": res.flagged,
                                 "proposal": res.proposal if res.ok else None}, ensure_ascii=False) + "\n")
    return 0 if res.ok else 2


if __name__ == "__main__":
    sys.exit(main())
