"""Tests for tools/scrape_state.py - /scrape Step 4's dedup-and-store helper.

A headless dashboard run lost a whole scrape because storing results meant an
improvised /tmp script no allowlist could approve. These pin the sanctioned
replacement: Step 4's dedup rules, never rewriting an existing entry, atomic
writes, input validation, and the job_scraper/ path confinement.
"""
import io
import json
import os
import subprocess
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "tools"))

import scrape_state  # noqa: E402
from job_key import make_key  # noqa: E402

TODAY = "2026-10-15"


def posting(**over):
    base = {
        "title": "Backend Engineer",
        "company": "Acme",
        "url": "https://example.com/jobs/1",
        "posted_date": "2026-10-14",
        "deadline": None,
        "fit": "high",
        "status": "new",
        "portal": "getonbrd-search",
        "source": "cli",
    }
    base.update(over)
    return base


class ScrapeStateTest(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.base = Path(self._tmp.name) / "job_scraper"
        self.base.mkdir()
        self.state = self.base / "seen_jobs.json"

    def tearDown(self):
        self._tmp.cleanup()

    def run_main(self, args, stdin_text=None):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = scrape_state.main(
                ["add", *args, "--today", TODAY],
                base=self.base,
                stdin=io.StringIO(stdin_text) if stdin_text is not None else None,
            )
        return code, out.getvalue(), err.getvalue()

    def stored(self):
        return json.loads(self.state.read_text(encoding="utf-8"))["seen"]

    def test_creates_state_and_stores_canonical_entry(self):
        code, out, _ = self.run_main([], json.dumps([posting()]))
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {"added": 1, "skipped": 0, "total": 1})
        key = make_key("Acme", "Backend Engineer", "https://example.com/jobs/1")
        entry = self.stored()[key]
        self.assertEqual(entry["first_seen"], TODAY)
        self.assertEqual(entry["portal"], "getonbrd-search")
        self.assertEqual(entry["source"], "cli")

    def test_accepts_mcp_source_for_indeed(self):
        code, out, _ = self.run_main([], json.dumps([posting(
            portal="indeed", source="mcp", url="https://to.indeed.com/aap79d4y6wvj#JOBSEARCH_100096")]))
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["added"], 1)
        entry = next(iter(self.stored().values()))
        self.assertEqual((entry["portal"], entry["source"]), ("indeed", "mcp"))

    def test_stores_optional_location(self):
        code, _, _ = self.run_main([], json.dumps([posting(location="Remote (Mexico)")]))
        self.assertEqual(code, 0)
        self.assertEqual(next(iter(self.stored().values()))["location"], "Remote (Mexico)")

    def test_stores_optional_tags_and_snippet(self):
        code, _, _ = self.run_main([], json.dumps([posting(tags=[" Python ", "Data Engineering", "python", ""], snippet="  Build ETL pipelines.  ")]))
        self.assertEqual(code, 0)
        entry = next(iter(self.stored().values()))
        self.assertEqual(entry["tags"], ["Python", "Data Engineering"])
        self.assertEqual(entry["snippet"], "Build ETL pipelines.")

    def test_omits_empty_tags_and_snippet(self):
        self.run_main([], json.dumps([posting(tags=[], snippet=None)]))
        entry = next(iter(self.stored().values()))
        self.assertNotIn("tags", entry)
        self.assertNotIn("snippet", entry)

    def test_rejects_malformed_tags_and_snippet(self):
        for bad in ({"tags": "python"}, {"tags": [1]}, {"snippet": 5}, {"snippet": "x" * 2001}):
            with self.subTest(bad=bad):
                code, _, err = self.run_main([], json.dumps([posting(**bad)]))
                self.assertEqual(code, 1)
                self.assertIn(next(iter(bad)), err)

    def test_tags_and_snippet_are_capped(self):
        code, _, _ = self.run_main([], json.dumps([posting(tags=[f"t{i}" for i in range(50)] + ["y" * 200], snippet="z" * 900)]))
        self.assertEqual(code, 0)
        entry = next(iter(self.stored().values()))
        self.assertEqual(len(entry["tags"]), scrape_state.MAX_TAGS)
        self.assertEqual(len(entry["snippet"]), scrape_state.MAX_SNIPPET)

    def test_rescrape_fills_missing_tags_without_rewriting_the_entry(self):
        self.run_main([], json.dumps([posting()]))
        key = next(iter(self.stored()))
        doc = json.loads(self.state.read_text(encoding="utf-8"))
        doc["seen"][key]["status"] = "ranked"
        self.state.write_text(json.dumps(doc), encoding="utf-8")
        code, out, _ = self.run_main([], json.dumps([posting(title="Changed", tags=["Python"], snippet="Hi")]))
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["enriched"], 1)
        entry = self.stored()[key]
        self.assertEqual((entry["status"], entry["title"], entry["tags"], entry["snippet"]), ("ranked", "Backend Engineer", ["Python"], "Hi"))
        code, out, _ = self.run_main([], json.dumps([posting(tags=["Other"])]))
        self.assertNotIn("enriched", json.loads(out))
        self.assertEqual(self.stored()[key]["tags"], ["Python"])

    def test_omits_empty_location(self):
        self.run_main([], json.dumps([posting(location=None)]))
        self.assertNotIn("location", next(iter(self.stored().values())))
        code, _, err = self.run_main([], json.dumps([posting(url="https://example.com/2", location=5)]))
        self.assertEqual(code, 1)
        self.assertIn("location", err)

    def test_rejects_unknown_source(self):
        code, _, err = self.run_main([], json.dumps([posting(source="scraper")]))
        self.assertEqual(code, 1)
        self.assertIn("source", err)

    def test_skips_url_already_stored_under_any_key(self):
        self.state.write_text(json.dumps({"seen": {"legacy_key_shape": {
            "title": "Other title", "company": "Other", "url": "https://example.com/jobs/1/",
            "status": "skipped"}}}), encoding="utf-8")
        code, out, _ = self.run_main([], json.dumps([posting()]))
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["skipped"], 1)
        self.assertEqual(list(self.stored()), ["legacy_key_shape"])

    def test_skips_existing_company_title(self):
        self.run_main([], json.dumps([posting()]))
        code, out, _ = self.run_main([], json.dumps([posting(url="https://example.com/jobs/other", company=" acme ")]))
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {"added": 0, "skipped": 1, "total": 1})

    def test_never_overwrites_ranked_entry(self):
        key = make_key("Acme", "Backend Engineer", "https://example.com/jobs/1")
        ranked = {"title": "Backend Engineer", "company": "Acme", "url": "https://example.com/jobs/1",
                  "status": "ranked", "rank_score": 81, "first_seen": "2026-10-01"}
        self.state.write_text(json.dumps({"seen": {key: ranked}}), encoding="utf-8")
        self.run_main([], json.dumps([posting(status="new")]))
        self.assertEqual(self.stored()[key], ranked)

    def test_dedups_within_one_batch(self):
        code, out, _ = self.run_main([], json.dumps([posting(), posting(url="https://example.com/jobs/1/")]))
        self.assertEqual(json.loads(out), {"added": 1, "skipped": 1, "total": 1})

    def test_file_input_is_consumed_on_success(self):
        incoming = self.base / "incoming.json"
        incoming.write_text(json.dumps([posting()]), encoding="utf-8")
        code, out, _ = self.run_main(["--file", str(incoming)])
        self.assertEqual(code, 0)
        self.assertFalse(incoming.exists())
        self.assertEqual(json.loads(out)["added"], 1)

    def test_rejects_paths_outside_job_scraper(self):
        outside = Path(self._tmp.name) / "evil.json"
        outside.write_text(json.dumps([posting()]), encoding="utf-8")
        code, _, err = self.run_main(["--file", str(outside)])
        self.assertEqual(code, 1)
        self.assertIn("outside", err)
        self.assertTrue(outside.exists())
        code, _, err = self.run_main(["--state", str(Path(self._tmp.name) / "seen.json")], json.dumps([posting()]))
        self.assertEqual(code, 1)
        self.assertFalse(self.state.exists())

    def test_rejects_traversal_via_dotdot(self):
        code, _, err = self.run_main(["--state", str(self.base / ".." / "seen.json")], json.dumps([posting()]))
        self.assertEqual(code, 1)
        self.assertIn("outside", err)

    def test_validation_rejects_bad_input_without_writing(self):
        bad_cases = [
            {"not": "a list"},
            [posting(url="file:///etc/passwd")],
            [posting(url="javascript:alert(1)")],
            [posting(status="applied")],
            [posting(source="scraper")],
            [posting(fit="great")],
            [posting(posted_date="15/10/2026")],
            [posting(title="")],
            [posting(extra="field")],
        ]
        for case in bad_cases:
            with self.subTest(case=case):
                code, _, err = self.run_main([], json.dumps(case))
                self.assertEqual(code, 1)
                self.assertIn("error", json.loads(err))
                self.assertFalse(self.state.exists())

    def test_invalid_existing_state_is_reported_not_clobbered(self):
        self.state.write_text("{broken", encoding="utf-8")
        code, _, err = self.run_main([], json.dumps([posting()]))
        self.assertEqual(code, 1)
        self.assertEqual(self.state.read_text(encoding="utf-8"), "{broken")

    def test_failed_write_leaves_previous_state_and_no_temp_file(self):
        self.run_main([], json.dumps([posting()]))
        before = self.state.read_text(encoding="utf-8")
        with mock.patch.object(scrape_state.os, "replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.run_main([], json.dumps([posting(url="https://example.com/jobs/2", title="Data Engineer")]))
        self.assertEqual(self.state.read_text(encoding="utf-8"), before)
        self.assertEqual([p.name for p in self.base.iterdir() if p.name.endswith(".tmp")], [])

    def test_cli_prints_utf8_json(self):
        proc = subprocess.run(
            [sys.executable, str(REPO / "tools" / "scrape_state.py"), "add", "--state", "/tmp/x.json"],
            input=b"[]", capture_output=True, cwd=str(REPO),
            env={**os.environ, "PYTHONIOENCODING": "ascii"},
        )
        self.assertEqual(proc.returncode, 1)
        self.assertIn(b"outside", proc.stderr)


if __name__ == "__main__":
    unittest.main()
