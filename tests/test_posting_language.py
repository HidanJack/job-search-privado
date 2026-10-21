"""Tests for tools/posting_language.py - language detection and the backfill."""
import copy
import importlib.util
import json
import sys
import unittest
from pathlib import Path

import sys as _sys
_sys.path.insert(0, str(Path(__file__).resolve().parent))
import _hermetic  # noqa: F401,E402  (pins profile_config to the test fixture)
from tempfile import TemporaryDirectory
from unittest import mock

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "tools"))
spec = importlib.util.spec_from_file_location("posting_language", REPO / "tools" / "posting_language.py")
pl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pl)

ES = "Buscamos un ingeniero con experiencia en el desarrollo de APIs para nuestro equipo, y con conocimientos de bases de datos."
EN = "We are looking for an engineer with strong experience in the team to work on our APIs and join the company."


def ranked(**over):
    base = {
        "status": "ranked",
        "portal": "himalayas-search",
        "url": "https://example.com/job",
        "title": "Data Engineer",
        "rank_score": 70,
        "language_gate": "PASS",
        "gaps": ["Kafka"],
        "strengths": ["Python"],
    }
    base.update(over)
    return base


class Detect(unittest.TestCase):
    def test_spanish(self):
        self.assertEqual(pl.detect_language(ES), "es")

    def test_english(self):
        self.assertEqual(pl.detect_language(EN), "en")

    def test_mixed(self):
        self.assertEqual(pl.detect_language(ES + " " + EN), "mixed")

    def test_too_short_is_none(self):
        self.assertIsNone(pl.detect_language("Data Engineer"))
        self.assertIsNone(pl.detect_language(""))
        self.assertIsNone(pl.detect_language(None))

    def test_html_is_stripped(self):
        self.assertEqual(pl.detect_language(f"<p class='the and of'>{EN}</p>"), "en")

    def test_title_needs_clear_signal(self):
        self.assertEqual(pl.detect_title("Engineer for the team and the data"), "en")
        self.assertIsNone(pl.detect_title("Back-end Software Engineer"))


class Backfill(unittest.TestCase):
    def setUp(self):
        d = TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.dir = Path(d.name)
        self.state = self.dir / "seen_jobs.json"

    def write(self, seen):
        self.state.write_text(json.dumps({"version": 1, "seen": seen}), encoding="utf-8")

    def read(self):
        return json.loads(self.state.read_text(encoding="utf-8"))["seen"]

    def test_fills_language_and_applies_english_rule_only(self):
        seen = {
            "en": ranked(),
            "es": ranked(),
            "done": ranked(posting_language="es"),
            "skipped": {"status": "skipped"},
        }
        self.write(seen)
        before = copy.deepcopy(seen)
        order = iter([EN, ES])
        summary = pl.backfill(self.state, fetch=lambda e: {"description": next(order)})
        after = self.read()
        self.assertEqual(summary["en"], ["en"])
        self.assertEqual(summary["es"], ["es"])
        self.assertEqual(after["en"]["posting_language"], "en")
        self.assertEqual(after["en"]["language_gate"], "FLAG")
        self.assertEqual(after["en"]["language_note"], pl.rank_state.ENGLISH_POSTING_NOTE)
        self.assertEqual(after["en"]["gaps"], [pl.rank_state.SPOKEN_ENGLISH_GAP, "Kafka"])
        # Spanish: only posting_language is added.
        self.assertEqual(after["es"], {**before["es"], "posting_language": "es"})
        # Untouched entries are identical.
        self.assertEqual(after["done"], before["done"])
        self.assertEqual(after["skipped"], before["skipped"])
        self.assertEqual(after["en"]["strengths"], ["Python"])
        self.assertEqual(after["en"]["rank_score"], 70)

    def test_failed_detail_leaves_entry_unchanged_and_reports(self):
        seen = {"a": ranked(), "b": ranked()}
        self.write(seen)

        def fetch(entry):
            if entry is not None and fetch.calls == 0:
                fetch.calls += 1
                raise RuntimeError("boom")
            return {"description": EN}

        fetch.calls = 0
        summary = pl.backfill(self.state, fetch=fetch)
        after = self.read()
        self.assertEqual([f["key"] for f in summary["failed"]], ["a"])
        self.assertEqual(after["a"], seen["a"])
        self.assertEqual(after["b"]["posting_language"], "en")

    def test_title_fallback_and_none(self):
        seen = {"t": ranked(title="Engineer for the team and the data"), "n": ranked(title="Data Engineer")}
        self.write(seen)
        summary = pl.backfill(self.state, fetch=lambda e: {"description": "", "title": e["title"]})
        self.assertEqual(summary["en"], ["t"])
        self.assertEqual(summary["none"], ["n"])
        self.assertNotIn("posting_language", self.read()["n"])

    def test_indeed_entries_are_skipped_without_fetching(self):
        self.write({"i": ranked(portal="indeed", title="Desarrollador Python"), "b": ranked()})
        calls = []

        def fetch(entry):
            calls.append(entry["portal"])
            return {"description": EN}

        summary = pl.backfill(self.state, fetch=fetch)
        self.assertEqual(calls, ["himalayas-search"])
        self.assertEqual(summary["none"], ["i"])
        self.assertNotIn("posting_language", self.read()["i"])

    def test_dry_run_writes_nothing(self):
        self.write({"a": ranked()})
        raw = self.state.read_bytes()
        summary = pl.backfill(self.state, dry_run=True, fetch=lambda e: {"description": EN})
        self.assertEqual(summary["en"], ["a"])
        self.assertEqual(self.state.read_bytes(), raw)

    def test_atomic_write_keeps_original_when_replace_fails(self):
        self.write({"a": ranked()})
        raw = self.state.read_bytes()
        with mock.patch("os.replace", side_effect=OSError("disk")):
            with self.assertRaises(OSError):
                pl.backfill(self.state, fetch=lambda e: {"description": EN})
        self.assertEqual(self.state.read_bytes(), raw)
        self.assertEqual([p.name for p in self.dir.iterdir()], ["seen_jobs.json"])

    def test_fetch_uses_no_shell_and_own_timeout(self):
        run = mock.Mock(return_value=mock.Mock(returncode=0, stdout='{"description": "x"}', stderr=""))
        pl.fetch_detail({"portal": "himalayas-search", "url": "u"}, run=run)
        argv = run.call_args.args[0]
        self.assertEqual(argv[0], "bun")
        self.assertFalse(run.call_args.kwargs["shell"])
        self.assertEqual(run.call_args.kwargs["timeout"], pl.FETCH_TIMEOUT)


if __name__ == "__main__":
    unittest.main()
