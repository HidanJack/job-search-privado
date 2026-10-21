"""profile_config.json: `languages` and `search.families` (config-driven sweep + Indeed strings)."""
import json
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "tools"))
import profile_config as pc  # noqa: E402


def load(doc):
    with TemporaryDirectory() as d:
        p = Path(d) / "profile_config.json"
        p.write_text(json.dumps(doc), encoding="utf-8")
        return pc.load(p)


FAM = {"name": "Backend", "queries": [{"text": "python backend", "lang": "en"}, {"text": "desarrollador python", "lang": "es"}]}


class Families(unittest.TestCase):
    def test_default_families_exist_and_are_neutral(self):
        cfg = pc.load(Path("/nonexistent/profile_config.json"))
        fams = cfg["search"]["families"]
        self.assertTrue(fams)
        langs = {q["lang"] for f in fams for q in f["queries"]}
        self.assertEqual(langs, {"en", "es"})
        self.assertEqual(cfg["languages"], [])

    def test_valid_families_replace_defaults(self):
        cfg = load({"search": {"families": [FAM]}})
        self.assertEqual(cfg["search"]["families"], [{"name": "Backend", "queries": FAM["queries"]}])

    def test_invalid_families_fall_back_key_by_key(self):
        for bad in ("x", [], [{"name": "", "queries": FAM["queries"]}], [{"name": "A", "queries": []}],
                    [{"name": "A", "queries": [{"text": "--latam", "lang": "en"}]}],
                    [{"name": "A", "queries": [{"text": "ok", "lang": "english"}]}]):
            cfg = load({"search": {"families": bad}})
            self.assertEqual(cfg["search"]["families"], pc.DEFAULTS["search"]["families"], bad)

    def test_bad_entries_are_dropped_good_ones_kept(self):
        cfg = load({"search": {"families": [FAM, {"name": "", "queries": []}, "junk"]}})
        self.assertEqual([f["name"] for f in cfg["search"]["families"]], ["Backend"])

    def test_optional_indeed_and_broad_fields(self):
        fam = {**FAM, "indeed": ["desarrollador python", "programador python"], "broad": True}
        got = load({"search": {"families": [fam]}})["search"]["families"][0]
        self.assertEqual(got["indeed"], ["desarrollador python", "programador python"])
        self.assertIs(got["broad"], True)

    def test_families_only_for_indeed_are_allowed(self):
        fam = {"name": "Web", "queries": [], "indeed": ["desarrollador web"]}
        self.assertEqual(load({"search": {"families": [fam]}})["search"]["families"][0]["indeed"], ["desarrollador web"])


class Languages(unittest.TestCase):
    def test_valid_languages(self):
        langs = [{"language": "English", "read": "B2", "write": "B2", "speak": "B1"},
                 {"language": "Spanish", "read": "native", "write": "native", "speak": "native"}]
        self.assertEqual(load({"languages": langs})["languages"], langs)

    def test_invalid_entries_dropped(self):
        got = load({"languages": [{"language": "English", "read": "fluent", "write": "B2", "speak": None}, "x",
                                  {"language": "", "read": "B1"}]})["languages"]
        self.assertEqual(got, [{"language": "English", "read": None, "write": "B2", "speak": None}])


class IndeedQueries(unittest.TestCase):
    def test_default_scope_skips_broad_and_prefers_spanish(self):
        cfg = load({"search": {"families": [
            {"name": "Core", "queries": [{"text": "python developer", "lang": "en"}, {"text": "desarrollador python", "lang": "es"},
                                         {"text": "Python Entwickler", "lang": "de"}]},
            {"name": "Side", "queries": [{"text": "qa analyst", "lang": "en"}], "broad": True},
        ]}})
        out = pc.indeed_queries(cfg)
        self.assertEqual(out, [{"family": "Core", "queries": ["desarrollador python", "python developer"]}])
        both = pc.indeed_queries(cfg, broad=True)
        self.assertEqual([f["family"] for f in both], ["Core", "Side"])

    def test_explicit_indeed_list_wins_and_dedupes(self):
        cfg = load({"search": {"families": [{**FAM, "indeed": ["a b", "A B", "c"]}]}})
        self.assertEqual(pc.indeed_queries(cfg), [{"family": "Backend", "queries": ["a b", "c"]}])

    def test_explicit_mode_when_any_family_lists_indeed_strings(self):
        cfg = load({"search": {"families": [
            {"name": "Sweep only", "queries": [{"text": "python", "lang": "en"}]},
            {"name": "Indeed row", "queries": [], "indeed": ["desarrollador python"]},
        ]}})
        self.assertEqual(pc.indeed_queries(cfg), [{"family": "Indeed row", "queries": ["desarrollador python"]}])

    def test_cli_prints_families_and_queries(self):
        with TemporaryDirectory() as d:
            p = Path(d) / "profile_config.json"
            p.write_text(json.dumps({"search": {"families": [FAM]}}), encoding="utf-8")
            r = subprocess.run([sys.executable, str(REPO / "tools" / "profile_config.py"), "queries", "--portal", "indeed"],
                               capture_output=True, text=True, env={"JOB_SEARCH_PROFILE_CONFIG": str(p), "PATH": "/usr/bin:/bin"})
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(r.stdout.splitlines(), ["# Backend", "desarrollador python", "python backend"])
            j = subprocess.run([sys.executable, str(REPO / "tools" / "profile_config.py"), "queries", "--portal", "indeed", "--json"],
                               capture_output=True, text=True, env={"JOB_SEARCH_PROFILE_CONFIG": str(p), "PATH": "/usr/bin:/bin"})
            self.assertEqual(json.loads(j.stdout), [{"family": "Backend", "queries": ["desarrollador python", "python backend"]}])

    def test_cli_rejects_unknown_portal(self):
        r = subprocess.run([sys.executable, str(REPO / "tools" / "profile_config.py"), "queries", "--portal", "nope"],
                           capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main()
