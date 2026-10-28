"""Company blocklist: normalization, matching, config validation, prefilter, suggestions."""
import json
import unittest
import _hermetic  # noqa: F401
import sys
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import company_blocklist as cb  # noqa: E402
import prefilter  # noqa: E402
import profile_config  # noqa: E402

TODAY = date(2026, 10, 28)


def entry(name, aliases=None, reason=None):
    e = {"name": name, "aliases": aliases or [], "added": "2026-10-28"}
    if reason:
        e["reason"] = reason
    return e


class NormalizeTests(unittest.TestCase):
    def test_case_accents_punctuation_and_spaces(self):
        self.assertEqual(cb.normalize("  Ácme-Spam,  CORP. "), "acme spam")

    def test_legal_suffixes_are_removed(self):
        for raw in ("Acme Spam Corp S.A. de C.V.", "Acme Spam, Inc.", "ACME SPAM LLC", "Acme Spam Ltd", "Acme Spam S.A.", "Acme Spam SA de CV"):
            self.assertEqual(cb.normalize(raw), "acme spam", raw)

    def test_a_name_that_is_only_a_suffix_survives(self):
        self.assertEqual(cb.normalize("Inc"), "inc")

    def test_empty(self):
        self.assertEqual(cb.normalize(None), "")


class MatchTests(unittest.TestCase):
    def test_equality_ignoring_noise_and_suffixes(self):
        blocked = [entry("Acme Spam Corp")]
        self.assertIsNotNone(cb.find_blocked("ACME SPAM, S.A. de C.V.", blocked))

    def test_alias_equality(self):
        blocked = [entry("Baires Corp", ["Baires Dev"])]
        self.assertEqual(cb.find_blocked("Baires Dev Inc", blocked)["name"], "Baires Corp")

    def test_containing_the_blocked_name_as_whole_words(self):
        blocked = [entry("TV Spam")]
        self.assertIsNotNone(cb.find_blocked("TV Spam Deportes", blocked))
        self.assertIsNotNone(cb.find_blocked("Grupo TV Spam", blocked))

    def test_partial_words_do_not_match(self):
        blocked = [entry("Spam")]
        self.assertIsNone(cb.find_blocked("Spamalot Studios", blocked))
        self.assertIsNone(cb.find_blocked("Antispam Labs", blocked))

    def test_a_shared_word_alone_does_not_match(self):
        blocked = [entry("TV Spam"), entry("Banco Spam")]
        self.assertIsNone(cb.find_blocked("Spam Tech Solutions", blocked))
        self.assertIsNone(cb.find_blocked("Banco Nacional", blocked))

    def test_no_entries_or_no_company(self):
        self.assertIsNone(cb.find_blocked("Acme", []))
        self.assertIsNone(cb.find_blocked(None, [entry("Acme")]))
        self.assertIsNone(cb.find_blocked("", [entry("Acme")]))


class ConfigTests(unittest.TestCase):
    def test_parse_validates_and_dedupes(self):
        raw = [
            {"name": "Acme Spam", "aliases": ["Acme", 7, "  "], "reason": "x" * 500, "added": "2026-10-28"},
            {"name": "acme spam inc"},                 # duplicate of the first after normalization
            {"name": ""}, "junk", {"aliases": ["z"]},
            {"name": "Other", "added": "28/10/2026"},
        ]
        out = cb.parse_entries(raw)
        self.assertEqual([e["name"] for e in out], ["Acme Spam", "Other"])
        self.assertEqual(out[0]["aliases"], ["Acme"])
        self.assertLessEqual(len(out[0]["reason"]), cb.MAX_REASON)
        self.assertIsNone(out[1]["added"])

    def test_not_a_list(self):
        self.assertEqual(cb.parse_entries(None), [])
        self.assertEqual(cb.parse_entries({"name": "x"}), [])

    def test_profile_config_loads_the_blocklist(self):
        with TemporaryDirectory() as d:
            p = Path(d) / "pc.json"
            p.write_text(json.dumps({"blocked_companies": [{"name": "Acme Spam Corp", "added": "2026-10-28"}]}))
            self.assertEqual(profile_config.load(p)["blocked_companies"][0]["name"], "Acme Spam Corp")
            p.write_text("{}")
            self.assertEqual(profile_config.load(p)["blocked_companies"], [])


class PrefilterTests(unittest.TestCase):
    def setUp(self):
        self._old = prefilter.BLOCKED
        prefilter.BLOCKED = [entry("Acme Spam Corp")]
        self.addCleanup(lambda: setattr(prefilter, "BLOCKED", self._old))

    def test_exclusion_reason(self):
        e = {"title": "Python Backend Developer", "company": "Acme Spam, S.A. de C.V.", "location": "Mexico"}
        self.assertEqual(prefilter.exclusion(e), "Empresa en tu lista negra")
        self.assertIsNone(prefilter.exclusion({**e, "company": "Other Co"}))

    def test_state_marks_pending_jobs_and_keeps_them(self):
        seen = {
            "a": {"status": "new", "title": "Python Backend Developer", "company": "Acme Spam Corp", "location": "Mexico"},
            "b": {"status": "new", "title": "Python Backend Developer", "company": "Fine Co", "location": "Mexico"},
            "c": {"status": "ranked", "title": "Python Backend Developer", "company": "Acme Spam Corp"},
        }
        counts = prefilter.prefilter_state(seen, TODAY, prefilter.load_search_settings(Path("/nonexistent")))
        self.assertEqual(seen["a"]["status"], prefilter.OUT_STATUS)
        self.assertEqual(seen["a"]["prefilter_reason"], "Empresa en tu lista negra")
        self.assertEqual(seen["b"]["status"], "new")
        self.assertEqual(seen["c"]["status"], "ranked")   # ranked jobs are hidden by the UI, never rewritten here
        self.assertEqual(counts["prefiltered_out"], 1)

    def test_recovery_still_works(self):
        e = {"status": prefilter.OUT_STATUS, "prefilter_reason": "Empresa en tu lista negra"}
        self.assertTrue(prefilter.recover_entry(e))
        self.assertEqual(e["status"], "new")


class SuggestionTests(unittest.TestCase):
    def jobs(self, company, n, age, **extra):
        return {f"{company}-{i}": {"company": company, "posted_date": f"2026-{(10 if age < 28 else 8):02d}-{(28 - age) if age < 28 else 28:02d}", **extra} for i in range(n)}

    def test_old_postings_company_is_suggested(self):
        seen = {**self.jobs("Old Postings Co", 9, 60), **self.jobs("Fresh Co", 9, 3), **self.jobs("Few Co", 3, 90)}
        out = cb.suggestions(seen, [], TODAY)
        self.assertEqual([s["company"] for s in out], ["Old Postings Co"])
        self.assertEqual(out[0]["count"], 9)
        self.assertGreater(out[0]["median_age_days"], 30)

    def test_many_reposts_are_suggested_even_when_fresh(self):
        seen = self.jobs("Repost Co", 10, 3, reposted=True)
        self.assertEqual([s["company"] for s in cb.suggestions(seen, [], TODAY)], ["Repost Co"])

    def test_blocked_companies_are_not_suggested_and_name_variants_group_together(self):
        seen = {**self.jobs("Old Postings Co", 5, 60), **self.jobs("Old Postings Co S.A. de C.V.", 4, 60)}
        self.assertEqual(cb.suggestions(seen, [], TODAY)[0]["count"], 9)
        self.assertEqual(cb.suggestions(seen, [entry("Old Postings Co")], TODAY), [])


if __name__ == "__main__":
    unittest.main()
