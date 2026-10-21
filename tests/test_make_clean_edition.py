"""Self-tests for tools/make_clean_edition.py: whitelist build and the leak scanner."""
import contextlib
import io
import shutil
import subprocess
import sys
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "tools"))
import make_clean_edition as mce  # noqa: E402

TOKEN = "PLANTED-SECRET-TOKEN"


def patterns_file(d: Path, *lines: str) -> Path:
    p = d / "patterns.txt"
    p.write_text("\n".join(lines or (TOKEN,)) + "\n", encoding="utf-8")
    return p


class Scanner(unittest.TestCase):
    def scan(self, tree_builder, *lines):
        with TemporaryDirectory() as d:
            d = Path(d)
            root = d / "tree"
            root.mkdir()
            tree_builder(root)
            return mce.scan_tree(root, mce.load_patterns(patterns_file(d, *lines)))

    def test_clean_tree_has_no_hits(self):
        self.assertEqual(self.scan(lambda r: (r / "a.txt").write_text("nothing here")), [])

    def test_finds_token_in_text_file(self):
        hits = self.scan(lambda r: (r / "a.txt").write_text(f"x {TOKEN} y"))
        self.assertEqual([h[0] for h in hits], ["a.txt"])

    def test_finds_token_in_binary_blob(self):
        hits = self.scan(lambda r: (r / "blob.bin").write_bytes(b"\x00\x01\xff" + TOKEN.encode() + b"\x00\x02"))
        self.assertTrue(hits)

    def test_finds_token_in_a_path_name(self):
        hits = self.scan(lambda r: (r / f"{TOKEN}.txt").write_text("harmless"))
        self.assertTrue(any("path name" in h[0] for h in hits))

    def test_finds_token_inside_zip_and_nested_zip(self):
        def build(r):
            inner = io.BytesIO()
            with zipfile.ZipFile(inner, "w") as zf:
                zf.writestr("deep/secret.txt", f"has {TOKEN}")
            with zipfile.ZipFile(r / "outer.zip", "w") as zf:
                zf.writestr("inner.zip", inner.getvalue())
        hits = self.scan(build)
        self.assertTrue(any("inner.zip!deep/secret.txt" in h[0] for h in hits), hits)

    @unittest.skipUnless(shutil.which("pdftotext"), "pdftotext not installed")
    def test_finds_token_in_pdf_text_layer(self):
        # A minimal one-page PDF whose content stream is compressed-free text drawn with Helvetica.
        text = TOKEN.replace("-", " ")
        stream = f"BT /F1 12 Tf 20 100 Td ({text}) Tj ET"
        objs = [
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        ]
        pdf = "%PDF-1.4\n"
        offsets = []
        for i, o in enumerate(objs, 1):
            offsets.append(len(pdf))
            pdf += f"{i} 0 obj\n{o}\nendobj\n"
        xref = len(pdf)
        pdf += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n" + "".join(f"{o:010d} 00000 n \n" for o in offsets)
        pdf += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
        # The pattern is the spaced form, which exists only in the rendered text layer, not as one raw literal.
        hits = self.scan(lambda r: (r / "doc.pdf").write_bytes(pdf.encode("latin-1")), text)
        self.assertTrue(any("pdftotext" in h[0] for h in hits), hits)

    def test_accent_and_case_insensitive_literals(self):
        hits = self.scan(lambda r: (r / "a.txt").write_text("el señor CATALAN y Catalán"), "catalán")
        self.assertEqual(len(hits), 1)

    def test_regex_pattern_and_word_boundary(self):
        hits = self.scan(lambda r: (r / "a.txt").write_text("stomach monarch Nachos"), r"re:\bNach\b")
        self.assertEqual(hits, [])
        hits = self.scan(lambda r: (r / "a.txt").write_text("Grupo Nach SA"), r"re:\bNach\b")
        self.assertEqual(len(hits), 1)

    def test_missing_pattern_file_is_a_clear_error(self):
        with self.assertRaises(mce.CleanEditionError) as ctx:
            mce.load_patterns(Path("/nonexistent/clean_edition_patterns.txt"))
        self.assertIn("not found", str(ctx.exception))

    def test_empty_pattern_file_is_refused(self):
        with TemporaryDirectory() as d:
            p = Path(d) / "p.txt"
            p.write_text("# only comments\n\n")
            with self.assertRaises(mce.CleanEditionError):
                mce.load_patterns(p)


class Whitelist(unittest.TestCase):
    def test_only_listed_paths_pass(self):
        ok = ["tools/prefilter.py", "ui/server.ts", ".agents/skills/getonbrd-search/SKILL.md", "LICENSE"]
        no = ["job_search_tracker.csv", "job_scraper/seen_jobs.json", "ui/state/settings.json",
              "cv/main_acme_dev.tex", "documents/applications/x/cv.pdf", ".git/config", "profile_config.json",
              "clean_edition_patterns.txt", "tools/make_clean_edition.py", "ui/node_modules/x/y.js",
              "tools/__pycache__/a.pyc", "company_research/acme.json", "CLAUDE.md"]
        for p in ok:
            self.assertTrue(mce.whitelisted(p), p)
        for p in no:
            self.assertFalse(mce.whitelisted(p), p)

    def test_documents_only_skeleton_in_a_real_checkout(self):
        files = mce.select_files(REPO)
        self.assertFalse([f for f in files if f.startswith("documents/") and not f.endswith((".gitkeep", "README.md"))])


class Build(unittest.TestCase):
    """End to end on the real repo with a harmless token list (the private list is not needed here)."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = TemporaryDirectory()
        cls.base = Path(cls.tmp.name)
        cls.out = cls.base / "edition"
        cls.pats = patterns_file(cls.base, "re:zzzz-never-present-zzzz")
        with contextlib.redirect_stdout(io.StringIO()):
            cls.rc = mce.run(cls.out, cls.pats)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_build_succeeds_and_zips(self):
        self.assertEqual(self.rc, 0)
        self.assertTrue(self.out.with_name("edition.zip").is_file())

    def test_excluded_things_are_absent(self):
        for rel in (".git", "job_scraper/seen_jobs.json", "ui/state", "profile_config.json", "clean_edition_patterns.txt",
                    "tools/make_clean_edition.py", "templates/clean_edition", ".atl", "company_research/x.json"):
            self.assertFalse((self.out / rel).exists(), rel)
        self.assertEqual((self.out / "job_search_tracker.csv").read_text(), mce.TRACKER_HEADER)

    def test_placeholder_versions_replace_the_personal_ones(self):
        claude = (self.out / "CLAUDE.md").read_text()
        self.assertIn("[YOUR_NAME]", claude)
        self.assertIn("Alex Example", (self.out / "cv" / "main_example.tex").read_text())
        self.assertTrue((self.out / "README.md").is_file())
        self.assertTrue((self.out / "NOTICE").is_file())
        self.assertTrue((self.out / "profile_config.example.json").is_file())
        self.assertTrue((self.out / ".not-upstream").is_file())

    def test_onboarding_files_ship_and_staging_does_not(self):
        for rel in ("tools/onboarding_extract.py", "tools/onboarding_proposal.py", "tools/onboarding_apply.py",
                    ".claude/commands/onboard.md", "ui/lib/onboarding.ts", "ui/tests/onboarding.test.ts",
                    "tests/fixtures/onboarding_proposal.json", "tests/fixtures/onboarding_template/CLAUDE.md",
                    "ui/tests/fixtures/cv_example.docx"):
            self.assertTrue((self.out / rel).is_file(), rel)
        self.assertFalse((self.out / "ui" / "state").exists())
        readme = (self.out / "README.md").read_text(encoding="utf-8")
        self.assertIn("Configuración inicial", readme)
        self.assertIn("/onboard", readme)
        # the applier must not treat the shipped edition as the author's private checkout
        self.assertFalse((self.out / "tools" / "make_clean_edition.py").exists())

    def test_discovery_files_ship_and_staging_does_not(self):
        for rel in ("tools/discovery_input.py", "tools/discovery_proposal.py", ".claude/commands/discover.md",
                    "ui/lib/discovery.ts", "ui/discover.ts", "ui/tests/discovery.test.ts",
                    "tests/test_discovery_input.py", "tests/test_discovery_proposal.py", "tests/test_discover_command.py"):
            self.assertTrue((self.out / rel).is_file(), rel)
        self.assertFalse((self.out / "ui" / "state").exists())
        readme = (self.out / "README.md").read_text(encoding="utf-8")
        self.assertIn("Descubrir caminos", readme)
        self.assertIn("/discover", readme)

    def test_shipped_edition_builds_a_discovery_input_for_a_blank_profile(self):
        import json as _json
        import shutil as _shutil
        import subprocess as _subprocess
        work = self.base / "discovering"
        _shutil.copytree(self.out, work)
        r = _subprocess.run([sys.executable, str(work / "tools" / "discovery_input.py"), "--root", str(work)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(_json.loads(r.stdout)["ok"])
        self.assertTrue((work / "ui" / "state" / "discovery" / "input.txt").is_file())

    def test_shipped_edition_applies_a_proposal_end_to_end(self):
        """The built edition can onboard a user: apply a proposal into a copy of it and read the result back."""
        import json as _json
        import shutil as _shutil
        import subprocess as _subprocess
        work = self.base / "onboarded"
        _shutil.copytree(self.out, work)
        prop = REPO / "tests" / "fixtures" / "onboarding_proposal.json"
        r = _subprocess.run([sys.executable, str(work / "tools" / "onboarding_apply.py"), "--root", str(work),
                             "--proposal", str(prop)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(_json.loads(r.stdout)["ok"])
        claude = (work / "CLAUDE.md").read_text(encoding="utf-8")
        self.assertIn("Job Application Assistant for Alex Example", claude)
        self.assertNotIn("[YOUR_NAME]", claude)
        cfg = _json.loads((work / "profile_config.json").read_text(encoding="utf-8"))
        self.assertEqual(cfg["name"], "Alex Example")

    def test_zip_has_a_single_top_level_folder_and_no_marker(self):
        with zipfile.ZipFile(self.out.with_name("edition.zip")) as zf:
            tops = {n.split("/")[0] for n in zf.namelist()}
            self.assertEqual(tops, {"edition"})
            self.assertFalse([n for n in zf.namelist() if n.endswith(mce.MARKER)])


class LeakStopsTheBuild(unittest.TestCase):
    def test_a_hit_means_nonzero_exit_and_no_zip(self):
        with TemporaryDirectory() as d:
            d = Path(d)
            out = d / "edition"
            # "Example" occurs in the generic templates: it plays the role of a leaked personal string.
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                rc = mce.run(out, patterns_file(d, "Alex Example"))
            self.assertEqual(rc, 1)
            self.assertFalse(out.with_name("edition.zip").exists())
            self.assertFalse(out.with_name("edition.zip.tmp").exists())

    def test_cli_without_patterns_file_fails_with_clear_error(self):
        with TemporaryDirectory() as d:
            r = subprocess.run([sys.executable, str(REPO / "tools" / "make_clean_edition.py"),
                                "--out", str(Path(d) / "e"), "--patterns", str(Path(d) / "missing.txt")],
                               capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        self.assertIn("pattern file not found", r.stderr)
        self.assertFalse((Path(d) / "e.zip").exists())

    def test_refuses_to_wipe_a_foreign_directory(self):
        with TemporaryDirectory() as d:
            d = Path(d)
            (d / "mine.txt").write_text("keep me")
            with self.assertRaises(mce.CleanEditionError):
                mce.build_tree(d)
            self.assertTrue((d / "mine.txt").exists())

    def test_refuses_output_inside_the_repo(self):
        with self.assertRaises(mce.CleanEditionError):
            mce.build_tree(REPO / "somewhere")


if __name__ == "__main__":
    unittest.main()
