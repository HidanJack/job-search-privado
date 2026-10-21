"""Tests for tools/profile_config.py - the per-user, gitignored profile_config.json."""
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "tools"))
import profile_config as pc  # noqa: E402


def write(dir_, doc):
    p = Path(dir_) / "profile_config.json"
    p.write_text(doc if isinstance(doc, str) else json.dumps(doc), encoding="utf-8")
    return p


class Defaults(unittest.TestCase):
    def test_missing_file_gives_neutral_defaults(self):
        with TemporaryDirectory() as d:
            cfg = pc.load(Path(d) / "nope.json")
        self.assertEqual(cfg["name"], "")
        self.assertEqual(cfg["candidate_years"], 3)
        self.assertEqual(cfg["years_tolerance"], 2)
        self.assertEqual(cfg["current_salary_mxn"], pc.DEFAULTS["current_salary_mxn"])
        self.assertEqual(cfg["salary_floor_mxn"], pc.DEFAULTS["salary_floor_mxn"])
        self.assertFalse(cfg["spoken_english"])
        self.assertTrue(cfg["prefilter"]["stack_points"])
        self.assertFalse(pc.is_filled(cfg))

    def test_malformed_json_falls_back_to_defaults(self):
        with TemporaryDirectory() as d:
            self.assertEqual(pc.load(write(d, "{not json")), pc.load(Path(d) / "nope.json"))
            self.assertEqual(pc.load(write(d, "[1,2]")), pc.load(Path(d) / "nope.json"))

    def test_defaults_do_not_leak_between_calls(self):
        with TemporaryDirectory() as d:
            a = pc.load(Path(d) / "x.json")
            a["prefilter"]["stack_points"].clear()
            self.assertTrue(pc.load(Path(d) / "x.json")["prefilter"]["stack_points"])


class Overrides(unittest.TestCase):
    def test_valid_values_override(self):
        with TemporaryDirectory() as d:
            cfg = pc.load(write(d, {"name": "Alex Example", "candidate_years": 9, "salary_floor_mxn": 50000,
                                    "spoken_english": True, "prefilter": {"stack_cap": 5}}))
        self.assertEqual((cfg["name"], cfg["candidate_years"], cfg["salary_floor_mxn"]), ("Alex Example", 9, 50000))
        self.assertTrue(cfg["spoken_english"])
        self.assertEqual(cfg["prefilter"]["stack_cap"], 5)
        self.assertTrue(cfg["prefilter"]["stack_points"])  # untouched keys keep their default
        self.assertTrue(pc.is_filled(cfg))

    def test_invalid_values_are_ignored_per_key(self):
        with TemporaryDirectory() as d:
            cfg = pc.load(write(d, {"name": 5, "candidate_years": "many", "salary_floor_mxn": -1,
                                    "current_salary_mxn": True, "spoken_english": "yes",
                                    "prefilter": {"stack_points": [{"words": [], "points": 3}, "x"], "stack_cap": "a"}}))
        base = pc.load(Path(d) / "nope.json")
        self.assertEqual(cfg, base)

    def test_stack_points_validated_entries_kept(self):
        with TemporaryDirectory() as d:
            cfg = pc.load(write(d, {"prefilter": {"stack_points": [{"words": ["zig"], "points": 7}, {"words": "bad", "points": 1}]}}))
        self.assertEqual(cfg["prefilter"]["stack_points"], [{"words": ["zig"], "points": 7}])

    def test_env_var_selects_the_file(self):
        with TemporaryDirectory() as d:
            p = write(d, {"name": "Env Person"})
            old = os.environ.get(pc.ENV_VAR)
            os.environ[pc.ENV_VAR] = str(p)
            try:
                self.assertEqual(pc.load()["name"], "Env Person")
            finally:
                if old is None:
                    del os.environ[pc.ENV_VAR]
                else:
                    os.environ[pc.ENV_VAR] = old


class ExampleFile(unittest.TestCase):
    def test_example_is_valid_and_neutral(self):
        path = REPO / "profile_config.example.json"
        doc = json.loads(path.read_text(encoding="utf-8"))
        cfg = pc.load(path)
        self.assertEqual(cfg["candidate_years"], doc["candidate_years"])
        self.assertFalse(pc.is_filled(cfg), "the example must read as 'not filled in yet'")

    def test_real_profile_config_is_gitignored(self):
        r = subprocess.run(["git", "check-ignore", "-q", "profile_config.json"], cwd=REPO)
        if r.returncode == 128:
            self.skipTest("not a git checkout")
        self.assertEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main()
