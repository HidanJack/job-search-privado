"""The CV headings table (05-cv-templates.md) and a real German compile of the sample template."""
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
# the private repo keeps the sample under templates/clean_edition/; the clean edition ships it as cv/
TEMPLATE = next((p for p in (REPO / "templates" / "clean_edition" / "cv" / "main_example.tex", REPO / "cv" / "main_example.tex") if p.is_file()),
                REPO / "cv" / "main_example.tex")
DOC = REPO / ".claude" / "skills" / "job-application-assistant" / "05-cv-templates.md"

GERMAN = [
    (r"\section{Core Competencies}", r"\section{Kernkompetenzen}"),
    (r"\section{Professional Experience}", r"\section{Berufserfahrung}"),
    (r"\section{Independent Projects}", r"\section{Eigene Projekte}"),
    (r"\section{Education}", r"\section{Ausbildung}"),
    (r"\section{Certifications}", r"\section{Zertifikate}"),
    (r"\section{Languages}", r"\section{Sprachen}"),
    (r"\section{References}", r"\section{Referenzen}"),
    ("Available upon request.", "Auf Anfrage erhältlich."),
    ("Spanish (native), English (upper-intermediate).", "Spanisch (Muttersprache), Englisch (fortgeschritten), Deutsch (B2)."),
    ("Bachelor's degree in Computer Engineering", "Bachelor in Informatik: Größen, Prüfungen, Öffnungszeiten"),
]


class HeadingsTable(unittest.TestCase):
    def test_table_covers_de_pt_fr_it_with_every_template_heading(self):
        text = DOC.read_text(encoding="utf-8")
        head = next(l for l in text.splitlines() if l.startswith("| English template |"))
        for lang in ("German (de)", "Portuguese (pt)", "French (fr)", "Italian (it)"):
            self.assertIn(lang, head)
        for heading in ("Core Competencies", "Professional Experience", "Education", "Languages", "References", "Available upon request."):
            row = next(l for l in text.splitlines() if l.startswith(f"| {heading} |"))
            self.assertEqual(len([c for c in row.strip("|").split("|") if c.strip()]), 5, heading)
        self.assertIn("Berufserfahrung", text)
        self.assertIn("Formação Acadêmica", text)


@unittest.skipUnless(shutil.which("lualatex"), "lualatex not installed")
class GermanCompile(unittest.TestCase):
    def test_german_sample_compiles_and_keeps_umlauts(self):
        source = TEMPLATE.read_text(encoding="utf-8")
        for old, new in GERMAN:
            self.assertIn(old, source, old)
            source = source.replace(old, new)
        with tempfile.TemporaryDirectory() as tmp:
            tex = Path(tmp) / "main_example_de.tex"
            tex.write_text(source, encoding="utf-8")
            proc = subprocess.run(["lualatex", "-interaction=nonstopmode", tex.name], cwd=tmp, capture_output=True, text=True, timeout=180)
            pdf = Path(tmp) / "main_example_de.pdf"
            self.assertTrue(pdf.is_file(), proc.stdout[-800:])
            checks = subprocess.run(
                [sys.executable, str(REPO / "tools" / "verify_pdf.py"), str(pdf), "--ats-integrity",
                 "--contains", "Größen, Prüfungen, Öffnungszeiten", "--contains", "Auf Anfrage erhältlich."],
                capture_output=True, text=True,
            )
            self.assertEqual(checks.returncode, 0, checks.stdout + checks.stderr)


if __name__ == "__main__":
    unittest.main()
