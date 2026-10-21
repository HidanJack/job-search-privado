#!/usr/bin/env python3
"""Validation of the career-path proposals that /discover writes (ui/state/discovery/proposals.json).

The proposal is produced by an LLM from the candidate's profile and from untrusted
internet text (job postings). Its queries are later run on public portals and
(when the user adds a path) written into profile_config.json, so it is validated
strictly and the honesty rules are enforced in code, not only in the prompt:

  * every `why_it_fits[].evidence` must be contained (normalised: case, accents,
    markdown and spacing ignored) in the PROFILE part of the input that /discover
    read, never in the job digest or the existing-search block. Items that fail are
    dropped with a warning; a path left with no verified evidence is removed;
  * queries are safe as CLI arguments (never a leading "-", no quotes/URLs/newlines,
    at most 80 characters), de-duplicated and de-duplicated against the user's
    existing search families;
  * a path already covered by an existing family goes to `skipped` ("ya lo buscas");
  * confidence is capped when evidence was dropped, is thin, or no gap is stated;
  * instruction-shaped text (posting_guard) removes the whole path;
  * at most 8 paths; unknown keys are dropped.

CLI:
  python3 tools/discovery_proposal.py validate --in FILE --input INPUT.txt [--root DIR] [--out FILE]
      prints {"ok","errors","repairs","dropped","proposal"}; exit 0 valid, 2 invalid.
  python3 tools/discovery_proposal.py add --root DIR --proposal FILE --id PATH_ID [--queries JSON_LIST]
      adds the path as a search family to DIR/profile_config.json (backup first); prints JSON.
"""
import argparse
import json
import os
import re
import sys
import unicodedata
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import posting_guard  # noqa: E402
import profile_config  # noqa: E402

VERSION = 1
MAX_PATHS = 8
MAX_QUERIES = 10
MAX_QUERY = 80
MAX_EVIDENCE_ITEMS = 8
MIN_EVIDENCE = 5
MAX_STR, MAX_LONG = 200, 600
SENIORITY = ("junior", "mid", "senior", "any")
CONFIDENCE = ("low", "medium", "high")
ALREADY = "ya lo buscas"
# Blocks of input.txt that describe the candidate. The job digest and the existing-search block are
# deliberately absent: a posting or an existing query is not evidence about the person.
EVIDENCE_BLOCKS_EXCLUDED = {"TOP_JOBS", "TITLE_WORDS", "EXISTING_SEARCH"}

CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
FENCE = re.compile(r"^\s*```(?:json)?\s*\n(.*?)\n\s*```\s*$", re.S)
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,48}$")
LANG = re.compile(r"^[a-z]{2,3}$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
BAD_QUERY = re.compile(r"""["'`|;$<>\\{}]|://|www\.""")
BLOCK = re.compile(r"^=== BEGIN ([A-Z_]+) (\S+) ===\n(.*?)\n=== END \1 \2 ===$", re.S | re.M)

TOP_KEYS = ["version", "generated", "paths", "skipped", "warnings"]
PATH_KEYS = ["id", "title", "summary", "why_it_fits", "gaps", "seniority_fit", "adjacent_to", "search_queries", "confidence", "inferred"]


def fold(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


@dataclass
class Result:
    proposal: dict = field(default_factory=dict)
    errors: list = field(default_factory=list)
    repairs: list = field(default_factory=list)
    dropped: list = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


def evidence_corpus(input_text: str) -> str:
    """Normalised text of the profile blocks of input.txt (the whole text when it has no blocks)."""
    blocks = BLOCK.findall(input_text or "")
    if not blocks:
        return fold(input_text or "")
    nonce_match = re.search(r"^NONCE: (\S+)", input_text or "", re.M)
    nonce = nonce_match.group(1) if nonce_match else None
    parts = [body for name, n, body in blocks if name not in EVIDENCE_BLOCKS_EXCLUDED and (nonce is None or n == nonce)]
    return fold("\n".join(parts))


def existing_from_root(root) -> dict:
    """{"families": [names], "queries": {(lang, folded text)}} from the effective search config of `root`."""
    path = Path(root) / "profile_config.json"
    cfg = profile_config.load(path)
    names, queries = [], set()
    for fam in cfg["search"]["families"]:
        names.append(fam["name"])
        for q in fam.get("queries", []):
            queries.add((q["lang"], fold(q["text"])))
        for text in fam.get("indeed", []):
            queries.add(("*", fold(text)))
    return {"families": names, "queries": queries}


GENERIC_WORDS = {"engineer", "engineers", "developer", "developers", "desarrollador", "ingeniero", "programador", "remote", "remoto",
                 "senior", "junior", "lead", "software", "backend", "frontend", "full", "stack", "de", "del", "la", "el", "y", "and", "of", "for", "en", "con"}


def _core(text: str) -> set:
    return {w for w in fold(text).split() if w not in GENERIC_WORDS}


class _Ctx:
    def __init__(self, input_text, existing, today):
        self.corpus = evidence_corpus(input_text)
        self.families = {fold(n): n for n in (existing or {}).get("families", [])}
        self.known = set((existing or {}).get("queries", set()))
        self.known_texts = {t for _, t in self.known}
        self.cover_cores = [c for c in (_core(n) for n in (existing or {}).get("families", [])) if c] + \
                           [c for c in (_core(t) for t in self.known_texts) if c]
        self.today = today
        self.res = Result()
        self.warnings: list = []

    def repair(self, msg):
        self.res.repairs.append(msg)

    def drop(self, title, reason, warning=None):
        self.res.dropped.append({"title": title, "reason": reason})
        self.warnings.append(warning or f"«{title}»: {reason}")


def _clean(ctx, v, maxlen):
    """Cleaned single-line string or None; flags instruction-like text via the second return value."""
    if not isinstance(v, str):
        return None, False
    s = CONTROL.sub("", v)
    s = posting_guard.clean_text(s)[0]
    s = re.sub(r"\s+", " ", s).strip()
    if not s:
        return None, False
    flagged = bool(posting_guard.scan(s, "")["instruction_like"])
    return s[:maxlen], flagged


def _slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", fold(text).replace(" ", "-")).strip("-")
    return (s or "path")[:49].strip("-") or "path"


def _query(ctx, q):
    if not isinstance(q, dict):
        ctx.repair("Se descartó una consulta que no era un objeto {text, lang}.")
        return None
    raw_text = q.get("text")
    text, _ = _clean(ctx, raw_text, 400)
    if isinstance(raw_text, str) and re.search(r"[\r\n]", raw_text.strip()):
        text = None
    lang = q.get("lang")
    lang = lang.strip().lower() if isinstance(lang, str) else ""
    if not text or len(text) > MAX_QUERY or text.startswith("-") or BAD_QUERY.search(text):
        ctx.repair(f"Se descartó la consulta no segura o demasiado larga «{str(q.get('text'))[:40]}».")
        return None
    if not LANG.match(lang):
        ctx.repair(f"Se descartó la consulta «{text}» porque su idioma no es un código de 2 o 3 letras.")
        return None
    return {"text": text, "lang": lang}


def _path(ctx: _Ctx, raw, index, used_ids):
    """A normalised path or None (dropped, with its reason recorded)."""
    label = f"paths[{index}]"
    if not isinstance(raw, dict):
        ctx.drop(label, "no es un objeto", f"Se descartó {label}: no es un objeto.")
        return None
    for k in raw:
        if k not in PATH_KEYS:
            ctx.repair(f"Se descartó el campo desconocido «{label}.{k}».")
    title, flag_t = _clean(ctx, raw.get("title"), 120)
    if not title:
        ctx.drop(label, "sin título", f"Se descartó {label}: le falta el título.")
        return None
    summary, flag_s = _clean(ctx, raw.get("summary"), MAX_LONG)
    flagged = flag_t or flag_s
    if not summary:
        ctx.drop(title, "sin resumen", f"Se descartó «{title}»: le falta el resumen.")
        return None

    # evidence
    items = raw.get("why_it_fits")
    kept, lost = [], 0
    for item in (items if isinstance(items, list) else [])[:MAX_EVIDENCE_ITEMS]:
        if not isinstance(item, dict):
            lost += 1
            continue
        claim, f1 = _clean(ctx, item.get("claim"), MAX_STR)
        evidence, f2 = _clean(ctx, item.get("evidence"), 300)
        flagged = flagged or f1 or f2
        norm = fold(evidence or "")
        if not claim or not evidence or len(norm) < MIN_EVIDENCE or norm not in ctx.corpus:
            lost += 1
            shown = (evidence or "")[:80]
            ctx.warnings.append(f"«{title}»: se descartó una justificación porque su evidencia no aparece en tu perfil: «{shown}».")
            continue
        kept.append({"claim": claim, "evidence": evidence})
    if flagged:
        ctx.drop(title, "texto con instrucciones", f"Se descartó «{title}»: contiene texto que parece instrucciones para una IA.")
        return None
    if not kept:
        ctx.drop(title, "sin evidencia verificable", f"Se descartó «{title}»: sin evidencia verificable en tu perfil.")
        return None

    # gaps / adjacency
    gaps = []
    for g in raw.get("gaps") if isinstance(raw.get("gaps"), list) else []:
        s, f = _clean(ctx, g, MAX_STR)
        if f:
            ctx.drop(title, "texto con instrucciones", f"Se descartó «{title}»: contiene texto que parece instrucciones para una IA.")
            return None
        if s:
            gaps.append(s)
    adjacent = []
    for a in raw.get("adjacent_to") if isinstance(raw.get("adjacent_to"), list) else []:
        s, _ = _clean(ctx, a, 80)
        if s and fold(s) in ctx.families:
            name = ctx.families[fold(s)]
            if name not in adjacent:
                adjacent.append(name)
        elif s:
            ctx.repair(f"Se quitó «{s}» de adjacent_to porque no es una de tus familias de búsqueda.")

    # queries
    queries, seen, dup = [], set(), 0
    for q in (raw.get("search_queries") if isinstance(raw.get("search_queries"), list) else [])[: MAX_QUERIES * 2]:
        nq = _query(ctx, q)
        if not nq:
            continue
        key = (nq["lang"], fold(nq["text"]))
        if key in seen:
            continue
        seen.add(key)
        if key in ctx.known or ("*", key[1]) in ctx.known:
            dup += 1
            continue
        queries.append(nq)
    queries = queries[:MAX_QUERIES]
    if fold(title) in ctx.families or (not queries and dup):
        ctx.res.dropped.append({"title": title, "reason": ALREADY})
        return ("skip", title)
    if not queries:
        ctx.drop(title, "sin consultas válidas", f"Se descartó «{title}»: no quedó ninguna consulta válida.")
        return None
    if not any(q["lang"] == "en" for q in queries):
        ctx.warnings.append(f"«{title}»: no tiene consultas en inglés.")

    # enums
    seniority = raw.get("seniority_fit")
    if seniority not in SENIORITY:
        ctx.repair(f"«{title}»: seniority_fit no válido, se usó «any».")
        seniority = "any"
    confidence = raw.get("confidence")
    if confidence not in CONFIDENCE:
        ctx.repair(f"«{title}»: confidence no válido, se usó «low».")
        confidence = "low"
    if confidence == "high" and (lost or len(kept) < 2 or not gaps):
        ctx.repair(f"«{title}»: la confianza bajó de «high» a «medium» (poca evidencia verificada o sin brechas declaradas).")
        confidence = "medium"
    inferred = raw.get("inferred")
    if not isinstance(inferred, bool):
        ctx.repair(f"«{title}»: inferred no era true/false, se usó true.")
        inferred = True

    pid = raw.get("id")
    pid = pid.strip() if isinstance(pid, str) else ""
    if not SLUG.match(pid):
        fixed = _slug(pid or title)
        ctx.repair(f"«{title}»: se corrigió el id «{pid[:30]}» a «{fixed}».")
        pid = fixed
    base, n = pid, 2
    while pid in used_ids:
        pid = f"{base[:46]}-{n}"
        n += 1
    used_ids.add(pid)
    return {"id": pid, "title": title, "summary": summary, "why_it_fits": kept, "gaps": gaps, "seniority_fit": seniority,
            "adjacent_to": adjacent, "search_queries": queries, "confidence": confidence, "inferred": inferred}


def validate(raw, input_text, existing=None, today=None) -> Result:
    ctx = _Ctx(input_text, existing, today or date.today().isoformat())
    res = ctx.res
    if not isinstance(raw, dict):
        res.errors.append({"path": "", "message": "La propuesta debe ser un objeto JSON."})
        return res
    for k in raw:
        if k not in TOP_KEYS:
            ctx.repair(f"Se descartó el campo desconocido «{k}».")
    if raw.get("version") != VERSION or isinstance(raw.get("version"), bool):
        res.errors.append({"path": "version", "message": f"«version» debe ser {VERSION} (versión del formato)."})
    if not isinstance(raw.get("paths"), list):
        res.errors.append({"path": "paths", "message": "Falta «paths» o no es una lista."})
        return res
    generated = raw.get("generated")
    if not (isinstance(generated, str) and DATE.match(generated)):
        ctx.repair(f"«generated» no era una fecha AAAA-MM-DD; se usó {ctx.today}.")
        generated = ctx.today

    paths_raw = raw["paths"]
    paths, skipped, used = [], [], set()
    for i, item in enumerate(paths_raw):
        got = _path(ctx, item, i, used)
        if got is None:
            continue
        if isinstance(got, tuple):
            skipped.append({"title": got[1], "reason": ALREADY})
        elif len(paths) >= MAX_PATHS:
            ctx.repair(f"Se descartaron los caminos sobrantes: el máximo es {MAX_PATHS}.")
            break
        else:
            paths.append(got)

    for s in raw.get("skipped") if isinstance(raw.get("skipped"), list) else []:
        if not isinstance(s, dict):
            continue
        t, _ = _clean(ctx, s.get("title"), 120)
        reason, _ = _clean(ctx, s.get("reason"), MAX_STR)
        if t and reason and fold(reason) == fold(ALREADY) and not any(c <= _core(t) for c in ctx.cover_cores):
            ctx.repair(f"«{t}»: la IA dijo «{ALREADY}» pero ninguna de tus búsquedas lo cubre; se cambió el motivo.")
            reason = "descartado por la IA; no coincide con tus búsquedas actuales"
        if t and reason and not any(fold(x["title"]) == fold(t) for x in skipped):
            skipped.append({"title": t, "reason": reason})
    model_warnings = []
    for w in raw.get("warnings") if isinstance(raw.get("warnings"), list) else []:
        s, _ = _clean(ctx, w, MAX_LONG)
        if s:
            model_warnings.append(s)

    if not paths:
        res.errors.append({"path": "paths", "message": "Ningún camino pasó la validación (sin evidencia verificable, consultas no válidas o ya los buscabas)."})
    res.proposal = {"version": VERSION, "generated": generated, "paths": paths, "skipped": skipped[:20],
                    "warnings": (model_warnings + ctx.warnings)[:40]}
    return res


def validate_text(text, input_text, existing=None, today=None) -> Result:
    body, repairs = text, []
    fence = FENCE.match(text or "")
    if fence:
        body = fence.group(1)
        repairs.append("Se quitó el bloque de código que envolvía el JSON.")
    try:
        raw = json.loads(body)
    except (ValueError, TypeError):
        res = Result()
        res.errors.append({"path": "", "message": "El archivo no es JSON válido."})
        return res
    res = validate(raw, input_text, existing, today)
    res.repairs = repairs + res.repairs
    return res


# ---------------------------------------------------------------------------
# Adding a path to the user's search families
# ---------------------------------------------------------------------------

class AddError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def _read_config(root: Path):
    path = root / "profile_config.json"
    if not path.is_file():
        raise AddError("config_missing", "No existe profile_config.json; no se escribió nada. Termina primero la configuración inicial.")
    try:
        cfg = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise AddError("config_invalid", "profile_config.json no es JSON válido; no se tocó.")
    if not isinstance(cfg, dict):
        raise AddError("config_invalid", "profile_config.json debe ser un objeto JSON; no se tocó.")
    return path, cfg


def added_ids(root) -> list:
    """Ids of the discovered paths already added as families (raw read of profile_config.json; never raises)."""
    try:
        cfg = json.loads((Path(root) / "profile_config.json").read_text(encoding="utf-8"))
        fams = cfg["search"]["families"]
    except (OSError, ValueError, KeyError, TypeError):
        return []
    out = []
    for f in fams if isinstance(fams, list) else []:
        sid = f.get("source_path_id") if isinstance(f, dict) else None
        if isinstance(sid, str) and sid not in out:
            out.append(sid)
    return out


def add_family(root, proposal_path, path_id, queries=None, now=None) -> dict:
    root = Path(root)
    try:
        stored = json.loads(Path(proposal_path).read_text(encoding="utf-8"))
        paths = stored["paths"]
    except (OSError, ValueError, KeyError, TypeError):
        raise AddError("no_proposals", "No hay propuestas guardadas.")
    path = next((p for p in paths if isinstance(p, dict) and p.get("id") == path_id), None)
    if path is None:
        raise AddError("path_not_found", "Ese camino no está en las propuestas.")
    cfg_path, cfg = _read_config(root)
    search = cfg.get("search") if isinstance(cfg.get("search"), dict) else {}
    families = search.get("families") if isinstance(search.get("families"), list) else []
    if path_id in added_ids(root):
        raise AddError("already_added", "Ese camino ya está en tus búsquedas.")

    offered = path["search_queries"]
    if queries is None:
        chosen = list(offered)
    else:
        if not isinstance(queries, list) or not queries:
            raise AddError("bad_queries", "Elige al menos una consulta.")
        chosen = []
        for item in queries:
            text = item.get("text") if isinstance(item, dict) else item
            lang = item.get("lang") if isinstance(item, dict) else None
            match = next((q for q in offered if isinstance(text, str) and fold(q["text"]) == fold(text) and (lang is None or q["lang"] == lang)), None)
            if match is None:
                raise AddError("bad_queries", "Una de las consultas elegidas no pertenece a este camino.")
            if match not in chosen:
                chosen.append(match)

    known = set()
    for f in families:
        for q in f.get("queries", []) if isinstance(f, dict) else []:
            if isinstance(q, dict) and isinstance(q.get("text"), str):
                known.add((str(q.get("lang", "")).lower(), fold(q["text"])))
    fresh = [q for q in chosen if (q["lang"], fold(q["text"])) not in known]
    duplicates = len(chosen) - len(fresh)
    if not fresh:
        raise AddError("no_new_queries", "Todas esas consultas ya están en tus búsquedas.")

    name = f"Descubierto: {path['title']}"[:80].rstrip()
    taken = {f.get("name") for f in families if isinstance(f, dict)}
    base, n = name, 2
    while name in taken:
        name = f"{base[:74]} ({n})"
        n += 1
    family = {"name": name, "queries": [{"text": q["text"], "lang": q["lang"]} for q in fresh],
              "discovered": True, "source_path_id": path_id}
    if not profile_config._families([family]):
        raise AddError("invalid_family", "La familia resultante no es válida; no se escribió nada.")

    new_cfg = dict(cfg)
    new_search = dict(search)
    new_search["families"] = [*families, family]
    new_cfg["search"] = new_search

    stamp = (now or datetime.now()).strftime("%Y%m%d-%H%M%S")
    bdir = root / "ui" / "state" / "backups" / f"discovery-{stamp}"
    k = 1
    while bdir.exists():
        k += 1
        bdir = root / "ui" / "state" / "backups" / f"discovery-{stamp}-{k}"
    backup = bdir / "profile_config.json"
    _atomic_write(backup, cfg_path.read_text(encoding="utf-8"))
    _atomic_write(cfg_path, json.dumps(new_cfg, ensure_ascii=False, indent=2) + "\n")
    return {"ok": True, "family": family, "added_queries": len(fresh), "duplicates": duplicates,
            "backup": backup.relative_to(root).as_posix()}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    val = sub.add_parser("validate")
    val.add_argument("--in", dest="infile", type=Path, required=True)
    val.add_argument("--input", dest="input_file", type=Path, required=True)
    val.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    val.add_argument("--out", type=Path)
    add = sub.add_parser("add")
    add.add_argument("--root", type=Path, required=True)
    add.add_argument("--proposal", type=Path, required=True)
    add.add_argument("--id", required=True)
    add.add_argument("--queries", help="JSON list of the selected query texts (default: all)")
    args = ap.parse_args(argv)
    for stream in (sys.stdout,):
        if getattr(stream, "reconfigure", None):
            stream.reconfigure(encoding="utf-8")

    if args.cmd == "add":
        try:
            queries = json.loads(args.queries) if args.queries else None
        except ValueError:
            print(json.dumps({"ok": False, "error": "bad_queries", "message": "Las consultas elegidas no son una lista JSON."}, ensure_ascii=False))
            return 2
        try:
            out = add_family(args.root, args.proposal, args.id, queries)
        except AddError as exc:
            print(json.dumps({"ok": False, "error": exc.code, "message": str(exc)}, ensure_ascii=False))
            return 2
        print(json.dumps(out, ensure_ascii=False))
        return 0

    try:
        text = args.infile.read_text(encoding="utf-8")
        input_text = args.input_file.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        res = Result()
        res.errors.append({"path": "", "message": "No se pudo leer la propuesta o su entrada."})
    else:
        res = validate_text(text, input_text, existing_from_root(args.root))
    if res.ok and args.out:
        _atomic_write(args.out, json.dumps(res.proposal, ensure_ascii=False, indent=2) + "\n")
    sys.stdout.write(json.dumps({"ok": res.ok, "errors": res.errors, "repairs": res.repairs, "dropped": res.dropped,
                                 "proposal": res.proposal if res.ok else None}, ensure_ascii=False) + "\n")
    return 0 if res.ok else 2


if __name__ == "__main__":
    sys.exit(main())
