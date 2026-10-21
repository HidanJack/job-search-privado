#!/usr/bin/env python3
"""Turn an uploaded CV (PDF, DOCX, TXT, MD) or free text into plain text for /onboard.

No third-party dependencies: PDF goes through `pdftotext` (poppler, a documented
requirement), DOCX through zipfile + XML parsing, TXT/MD are read as UTF-8.

Everything extracted is UNTRUSTED DATA. It is run through tools/posting_guard.py
(invisible characters stripped, instruction-like lines flagged); a warning from
that gate is returned in `warnings` and ends up in the proposal's `warnings`.

Hard limits: MAX_FILE_BYTES per file, MAX_TEXT_CHARS of text. Anything else is
rejected with an ExtractError whose message is Spanish (it is shown to the user).

CLI (used by ui/lib/onboarding.ts):
  python3 tools/onboarding_extract.py --file PATH [--name ORIGINAL_NAME]
  python3 tools/onboarding_extract.py --free PATH
Prints one JSON object: {"text","kind","truncated","warnings"} or, with exit
code 2, {"error": code, "message": "..."}.
"""
import argparse
import io
import json
import re
import shutil
import subprocess
import sys
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from xml.etree import ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent))
import posting_guard  # noqa: E402

MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_TEXT_CHARS = 60_000
MAX_XML_BYTES = 20 * 1024 * 1024  # decompressed word/document.xml, guards against zip bombs
PDF_TIMEOUT = 30
KINDS = {".pdf": "pdf", ".docx": "docx", ".txt": "txt", ".md": "md"}
W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


class ExtractError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass
class Extracted:
    text: str
    kind: str
    truncated: bool = False
    warnings: list = field(default_factory=list)


def kind_of(filename: str) -> str:
    name = str(filename or "")
    ext = Path(name).suffix.lower()
    # "cv.pdf.sh" has suffix .sh; "cv" has none: both rejected below.
    return KINDS.get(ext, "")


def _pdf_text(data: bytes) -> str:
    if not data.startswith(b"%PDF-"):
        raise ExtractError("corrupt", "El archivo no parece un PDF válido.")
    if not shutil.which("pdftotext"):
        raise ExtractError(
            "pdftotext_missing",
            "Falta `pdftotext` (paquete poppler-utils) para leer PDF. Instálalo, o sube tu CV como .docx, .txt o .md.",
        )
    try:
        r = subprocess.run(["pdftotext", "-layout", "-enc", "UTF-8", "-", "-"], input=data,
                           capture_output=True, timeout=PDF_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise ExtractError("corrupt", "El PDF tardó demasiado en leerse; prueba con otra versión del archivo.")
    except OSError as exc:
        raise ExtractError("pdftotext_missing", f"No se pudo ejecutar pdftotext: {exc}")
    if r.returncode != 0:
        raise ExtractError("corrupt", "No se pudo leer el PDF (¿está dañado o protegido con contraseña?).")
    text = r.stdout.decode("utf-8", errors="replace")
    if not text.strip():
        raise ExtractError(
            "pdf_no_text",
            "Ese PDF no tiene texto seleccionable (parece un escaneo). Sube una versión con texto, .docx, .txt o .md, "
            "o cuéntanos tu experiencia en el cuadro de texto.",
        )
    return text


def _paragraph(p) -> str:
    out = []
    for el in p.iter():
        if el.tag == W_NS + "t" and el.text:
            out.append(el.text)
        elif el.tag == W_NS + "tab":
            out.append("\t")
        elif el.tag in (W_NS + "br", W_NS + "cr"):
            out.append("\n")
    return "".join(out)


def _blocks(el, lines: list) -> None:
    for child in el:
        if child.tag == W_NS + "p":
            lines.append(_paragraph(child))
        elif child.tag == W_NS + "tbl":
            for tr in child.iter(W_NS + "tr"):
                cells = []
                for tc in tr.findall(W_NS + "tc"):
                    inner: list = []
                    _blocks(tc, inner)
                    cells.append(" ".join(s.strip() for s in inner if s.strip()))
                row = " | ".join(c for c in cells if c)
                if row:
                    lines.append(row)
        elif child.tag in (W_NS + "sdt", W_NS + "sdtContent"):
            _blocks(child, lines)


def _docx_text(data: bytes) -> str:
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ExtractError("corrupt", "El archivo no parece un .docx válido.")
    with zf:
        try:
            info = zf.getinfo("word/document.xml")
        except KeyError:
            raise ExtractError("corrupt", "El .docx no contiene word/document.xml.")
        if info.file_size > MAX_XML_BYTES:
            raise ExtractError("file_too_large", "El contenido del .docx es demasiado grande.")
        with zf.open(info) as fh:
            xml = fh.read(MAX_XML_BYTES + 1)
    if len(xml) > MAX_XML_BYTES:
        raise ExtractError("file_too_large", "El contenido del .docx es demasiado grande.")
    if re.search(rb"<!(DOCTYPE|ENTITY)", xml, re.I):
        raise ExtractError("corrupt", "El .docx contiene declaraciones XML no permitidas.")
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        raise ExtractError("corrupt", "No se pudo leer el contenido del .docx.")
    body = root.find(W_NS + "body")
    if body is None:
        raise ExtractError("corrupt", "El .docx no tiene cuerpo de documento.")
    lines: list = []
    _blocks(body, lines)
    return "\n".join(lines)


def _txt(data: bytes) -> str:
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ExtractError("not_utf8", "El archivo de texto no está en UTF-8. Guárdalo como UTF-8 o pega el contenido en el cuadro de texto.")


def _finish(raw: str, kind: str) -> Extracted:
    cleaned, findings = posting_guard.guard(raw, "text")
    cleaned = cleaned.strip()
    if not cleaned:
        raise ExtractError("empty", "No se encontró texto en el archivo.")
    warnings = []
    verdict = findings.get("verdict", "")
    if "⚠" in verdict:
        warnings.append(f"⚠ Contenido sospechoso en lo que subiste: {verdict.replace('posting_guard: ', '')}. Se trató solo como datos.")
    truncated = len(cleaned) > MAX_TEXT_CHARS
    if truncated:
        cleaned = cleaned[:MAX_TEXT_CHARS]
        warnings.append(f"El texto se recortó a {MAX_TEXT_CHARS} caracteres; lo que sigue no se analizó.")
    return Extracted(cleaned, kind, truncated, warnings)


def extract(filename: str, data: bytes) -> Extracted:
    kind = kind_of(filename)
    if not kind:
        raise ExtractError("unsupported_type", "Formato no admitido. Usa PDF, DOCX, TXT o MD.")
    if len(data) > MAX_FILE_BYTES:
        raise ExtractError("file_too_large", "El archivo pesa más de 2 MB.")
    if kind == "pdf":
        raw = _pdf_text(data)
    elif kind == "docx":
        raw = _docx_text(data)
    else:
        raw = _txt(data)
    if not raw.strip():
        raise ExtractError("empty", "No se encontró texto en el archivo.")
    return _finish(raw, kind)


def extract_text(text: str) -> Extracted:
    """Free text typed by the user: same gate and cap, kind "text"."""
    if not isinstance(text, str) or not text.strip():
        raise ExtractError("empty", "El texto está vacío.")
    if len(text.encode("utf-8")) > MAX_FILE_BYTES:
        raise ExtractError("file_too_large", "El texto pesa más de 2 MB.")
    return _finish(text, "text")


def _emit(obj: dict, code: int = 0) -> int:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    return code


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--file", type=Path)
    group.add_argument("--free", type=Path, help="UTF-8 file with free text")
    ap.add_argument("--name", help="original file name (decides the type); default: the path's name")
    args = ap.parse_args(argv)
    try:
        path = args.file or args.free
        if path.stat().st_size > MAX_FILE_BYTES:
            raise ExtractError("file_too_large", "El archivo pesa más de 2 MB.")
        data = path.read_bytes()
        if args.free:
            res = extract_text(_txt(data))
        else:
            res = extract(args.name or path.name, data)
    except ExtractError as exc:
        return _emit({"error": exc.code, "message": str(exc)}, 2)
    except OSError as exc:
        return _emit({"error": "unreadable", "message": f"No se pudo leer el archivo: {exc}"}, 2)
    return _emit({"text": res.text, "kind": res.kind, "truncated": res.truncated, "warnings": res.warnings})


if __name__ == "__main__":
    sys.exit(main())
