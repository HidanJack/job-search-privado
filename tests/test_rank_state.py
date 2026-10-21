"""Tests for tools/rank_state.py - /rank's state helper (#395).

/rank used to pull the whole of seen_jobs.json through the model's context to
select candidates, then emit it back to record scores. That cost the whole
backlog per run no matter how few jobs were being scored, and it grew for the
life of the workspace. These pin the behaviour the three subcommands took
over: selection matches Step 1's existing rules, the sweep matches rule 6
exactly (including its two defensive-parse edge cases), and the write-back
matches Step 4's existing rules exactly - the location_verdict legacy
migration, the deadline null-is-not-a-correction rule, and verbatim
strengths/gaps persistence.
"""
import csv
import json
import subprocess
import sys
import unittest
from pathlib import Path

import sys as _sys
_sys.path.insert(0, str(Path(__file__).resolve().parent))
import _hermetic  # noqa: F401,E402  (pins profile_config to the test fixture)
from tempfile import TemporaryDirectory

REPO = Path(__file__).resolve().parent.parent
TOOL = REPO / "tools" / "rank_state.py"

TODAY = "2026-09-03"


def entry(**over):
    base = {
        "title": "SOC Analyst",
        "company": "Acme",
        "url": "https://example.com/job",
        "first_seen": "2026-08-30",
        "deadline": None,
        "status": "new",
        "portal": "linkedin-search",
    }
    base.update(over)
    return base


class RankStateCase(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.state = self.tmp / "seen_jobs.json"
        self.addCleanup(self._tmp.cleanup)
        # Gate off by default so selection tests are about selection; gate tests override.
        self.settings = self.tmp / "settings.json"
        self.write_settings(minPrefilterScore=0)

    def write_settings(self, **search):
        self.settings.write_text(json.dumps({"search": search}), encoding="utf-8")

    def write_state(self, seen):
        self.state.write_text(json.dumps({"seen": seen}), encoding="utf-8")

    def run_tool(self, *args, expect=0):
        proc = subprocess.run(
            [sys.executable, str(TOOL), *args, "--state", str(self.state), "--today", TODAY, "--settings", str(self.settings)],
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        self.assertEqual(proc.returncode, expect, proc.stderr)
        return json.loads(proc.stdout)

    def results(self, payload):
        path = self.tmp / "results.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return str(path)

    def read_state(self):
        return json.loads(self.state.read_text(encoding="utf-8"))["seen"]


class Candidates(RankStateCase):
    def test_selects_only_new_entries_and_projects_a_compact_row(self):
        self.write_state(
            {
                "a": entry(),
                "b": entry(status="ranked", rank_score=70),
                "c": entry(status="skipped"),
                "d": entry(status="expired"),
            }
        )
        out = self.run_tool("candidates", "--tracker", str(self.tmp / "none.csv"))
        self.assertEqual([row["key"] for row in out["selected"]], ["a"])
        self.assertEqual(
            set(out["selected"][0]),
            {"key", "title", "company", "url", "portal", "deadline", "posted_date"},
            "the projection is the point: strengths/gaps and every other stored field "
            "stay on disk rather than entering the conversation",
        )

    def test_limit_defers_the_rest_and_reports_the_count(self):
        self.write_state({f"k{i}": entry(title=f"Role {i}") for i in range(25)})
        out = self.run_tool("candidates", "--limit", "10", "--tracker", str(self.tmp / "none.csv"))
        self.assertEqual(len(out["selected"]), 10)
        self.assertEqual(out["eligible"], 25)
        self.assertEqual(
            out["deferred"],
            15,
            "a backlog larger than the batch limit must be reported, not silently truncated - "
            "the user has to know a re-run continues it",
        )

    def test_limit_zero_means_no_cap(self):
        self.write_state({f"k{i}": entry(title=f"Role {i}") for i in range(15)})
        out = self.run_tool("candidates", "--limit", "0", "--tracker", str(self.tmp / "none.csv"))
        self.assertEqual(len(out["selected"]), 15)
        self.assertEqual(out["deferred"], 0)

    def gated_state(self):
        # Scores (today 2026-09-03, stored prefilter_score honoured via recovered flag):
        self.write_state(
            {
                "hi": entry(title="Hi", prefilter_score=60, prefilter_recovered=True),
                "mid": entry(title="Mid", prefilter_score=52, prefilter_recovered=True),
                "lo": entry(title="Lo", prefilter_score=40, prefilter_recovered=True),
                "lo2": entry(title="Lo2", prefilter_score=30, prefilter_recovered=True),
            }
        )

    def test_gate_returns_only_new_jobs_at_or_above_min_score_best_first(self):
        self.gated_state()
        self.write_settings(minPrefilterScore=52, rankBatch=10)
        out = self.run_tool("candidates", "--tracker", str(self.tmp / "none.csv"))
        self.assertEqual([r["key"] for r in out["selected"]], ["hi", "mid"])
        self.assertEqual(out["below_gate"], 2)
        self.assertEqual(out["min_prefilter_score"], 52)
        self.assertEqual(self.read_state()["lo"]["status"], "new", "gated jobs stay new")

    def test_gate_then_batch_limit(self):
        self.gated_state()
        self.write_settings(minPrefilterScore=40, rankBatch=1)
        out = self.run_tool("candidates", "--tracker", str(self.tmp / "none.csv"))
        self.assertEqual([r["key"] for r in out["selected"]], ["hi"])
        self.assertEqual(out["eligible"], 3)
        self.assertEqual(out["deferred"], 2)

    def test_force_rank_bypasses_gate_and_batch_limit(self):
        self.gated_state()
        state = self.read_state()
        state["lo2"]["force_rank"] = True
        self.write_state(state)
        self.write_settings(minPrefilterScore=52, rankBatch=1)
        out = self.run_tool("candidates", "--tracker", str(self.tmp / "none.csv"))
        self.assertEqual([r["key"] for r in out["selected"]], ["lo2", "hi"])
        self.assertEqual(out["forced"], 1)

    def test_force_rank_is_cleared_once_the_job_is_scored(self):
        self.gated_state()
        state = self.read_state()
        state["lo2"]["force_rank"] = True
        self.write_state(state)
        result = {"key": "lo2", "status": "scored", "deadline": None,
                  "scores": {d: 80 for d in ("technical", "experience", "behavioral", "career")},
                  "location_verdict": "PASS", "language_gate": "PASS", "posting_language": "es"}
        self.run_tool("apply", "--results", self.results([result]))
        after = self.read_state()["lo2"]
        self.assertEqual(after["status"], "ranked")
        self.assertNotIn("force_rank", after)

    def test_ranked_jobs_are_never_selected_automatically_even_with_force_flag(self):
        self.write_state({"r": entry(status="ranked", rank_score=70, prefilter_score=99, force_rank=True)})
        self.write_settings(minPrefilterScore=0)
        out = self.run_tool("candidates", "--tracker", str(self.tmp / "none.csv"))
        self.assertEqual(out["selected"], [])

    def test_gate_applies_only_to_new_jobs_under_all(self):
        self.write_state({"r": entry(status="ranked", rank_score=70, prefilter_score=1), "n": entry(prefilter_score=1, prefilter_recovered=True)})
        self.write_settings(minPrefilterScore=52)
        out = self.run_tool("candidates", "--all", "--tracker", str(self.tmp / "none.csv"))
        self.assertEqual([r["key"] for r in out["selected"]], ["r"])

    def test_tracker_pairs_are_excluded(self):
        self.write_state({"a": entry(company="Acme", title="SOC Analyst"), "b": entry(company="Other")})
        tracker = self.tmp / "tracker.csv"
        tracker.write_text("date,company,role\n2026-08-01,ACME,soc analyst\n", encoding="utf-8")
        out = self.run_tool("candidates", "--tracker", str(tracker))
        self.assertEqual([row["key"] for row in out["selected"]], ["b"])
        self.assertEqual(out["excluded_by_tracker"], 1)

    def test_tracker_exclusion_handles_utf8_bom_and_reordered_columns(self):
        self.write_state({"a": entry(company="Acme", title="SOC Analyst"), "b": entry(company="Other")})
        tracker = self.tmp / "tracker.csv"
        # A spreadsheet export can prepend a BOM to either matching column.
        for encoding in ("utf-8", "utf-8-sig"):
            for csv_text in (
                "date,company,role\r\n2026-08-01,ACME,soc analyst\r\n",
                "company,role,date\r\nACME,soc analyst,2026-08-01\r\n",
                "role,company,date\r\nsoc analyst,ACME,2026-08-01\r\n",
            ):
                with self.subTest(encoding=encoding, header=csv_text.splitlines()[0]):
                    tracker.write_bytes(csv_text.encode(encoding))
                    out = self.run_tool("candidates", "--tracker", str(tracker))
                    self.assertEqual([row["key"] for row in out["selected"]], ["b"])
                    self.assertEqual(out["excluded_by_tracker"], 1)

    def test_tracker_exclusion_preserves_unicode_identity(self):
        # Use the standard /outcome header and the real candidates CLI.
        header = (
            "date,company,sector,role,role_type,channel,status,contact_person,"
            "fit_rating,notes,cv_file,cover_letter_file,source,deadline"
        ).split(",")
        cases = (
            # Tracked company/role, candidate company/title, expected exclusion.
            ("Acme", "设计师", "Acme", "工程师", False),
            ("Acme", "工程师", "Acme", "工程师", True),
            ("腾讯", "Engineer", "腾讯", "Engineer", True),
            ("腾讯", "Engineer", "阿里巴巴", "Engineer", False),
            ("Компания", "Инженер", "КОМПАНИЯ", "ИНЖЕНЕР", True),
            ("Café", "Engineer", "Cafe\u0301", "Engineer", True),
            ("Straße", "Engineer", "STRASSE", "Engineer", True),
            ("कला Labs", "Engineer", "कल Labs", "Engineer", False),
            ("Acme, Inc.", "SOC Analyst", "ACME_INC", "soc-analyst", True),
        )
        tracker = self.tmp / "tracker.csv"
        for company, role, candidate_company, title, excluded in cases:
            with self.subTest(tracked=(company, role), candidate=(candidate_company, title)):
                self.write_state({
                    "candidate": entry(company=candidate_company, title=title),
                    "other": entry(company="Other", title="Untracked role"),
                })
                with tracker.open("w", encoding="utf-8", newline="") as fh:
                    writer = csv.DictWriter(fh, fieldnames=header)
                    writer.writeheader()
                    writer.writerow({"date": TODAY, "company": company, "role": role, "status": "applied"})
                out = self.run_tool("candidates", "--tracker", str(tracker))
                self.assertEqual(
                    [row["key"] for row in out["selected"]],
                    ["other"] if excluded else ["candidate", "other"],
                )
                self.assertEqual(out["excluded_by_tracker"], int(excluded))

    def test_focus_filters_on_title_company_and_stored_fit_notes(self):
        self.write_state(
            {
                "a": entry(title="Data Scientist"),
                "b": entry(title="SOC Analyst"),
                "c": entry(title="Engineer", strengths=["strong data science match"]),
            }
        )
        out = self.run_tool("candidates", "--focus", "data scien", "--tracker", str(self.tmp / "n.csv"))
        self.assertEqual(sorted(row["key"] for row in out["selected"]), ["a", "c"])

    def test_all_flag_includes_every_status_but_skipped(self):
        self.write_state(
            {
                "a": entry(status="ranked"),
                "b": entry(status="expired"),
                "c": entry(status="skipped"),
                "d": entry(status="new"),
            }
        )
        out = self.run_tool("candidates", "--all", "--tracker", str(self.tmp / "n.csv"))
        self.assertEqual(sorted(row["key"] for row in out["selected"]), ["a", "b", "d"])

    def test_missing_state_file_exits_nonzero(self):
        proc = subprocess.run(
            [sys.executable, str(TOOL), "candidates", "--state", str(self.tmp / "nope.json"),
             "--tracker", str(self.tmp / "n.csv")],
            capture_output=True, text=True, encoding="utf-8",
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("not found", proc.stderr + proc.stdout)


class Sweep(RankStateCase):
    def test_retires_past_deadlines_and_flags_the_closing_ones(self):
        self.write_state(
            {
                "past": entry(status="ranked", deadline="2026-09-01"),
                "soon": entry(status="ranked", deadline="2026-09-07"),
                "later": entry(status="ranked", deadline="2026-12-01"),
            }
        )
        out = self.run_tool("sweep", "--write")
        self.assertEqual([r["key"] for r in out["newly_expired"]], ["past"])
        self.assertEqual([r["key"] for r in out["closing_soon"]], ["soon"])
        self.assertEqual(self.read_state()["past"]["status"], "expired")
        self.assertEqual(self.read_state()["soon"]["status"], "ranked")

    def test_entries_without_a_deadline_are_left_alone(self):
        """The majority case. Inferring one from first_seen would retire jobs
        on a date nobody set."""
        self.write_state({"a": entry(status="ranked", deadline=None), "b": entry(status="ranked")})
        out = self.run_tool("sweep", "--write")
        self.assertEqual(out["newly_expired"], [])
        self.assertTrue(all(e["status"] == "ranked" for e in self.read_state().values()))

    def test_non_iso_deadlines_are_reported_not_compared(self):
        """Portals have shipped "ASAP", DD.MM.YYYY and free text into this field."""
        self.write_state(
            {
                "asap": entry(status="ranked", deadline="ASAP", portal="jobindex-search"),
                "euro": entry(status="ranked", deadline="31.08.2026", portal="jobbank-search"),
            }
        )
        out = self.run_tool("sweep", "--write")
        self.assertEqual(out["newly_expired"], [])
        self.assertEqual(
            sorted(r["portal"] for r in out["unparseable_deadlines"]),
            ["jobbank-search", "jobindex-search"],
            "a bad stored value is traced back to the portal that wrote it",
        )
        self.assertTrue(all(e["status"] == "ranked" for e in self.read_state().values()))

    def test_only_ranked_entries_are_swept_and_excluded_keys_are_skipped(self):
        self.write_state(
            {
                "new_past": entry(status="new", deadline="2026-09-01"),
                "rescored": entry(status="ranked", deadline="2026-09-01"),
                "other": entry(status="ranked", deadline="2026-09-01"),
            }
        )
        out = self.run_tool("sweep", "--write", "--exclude", "rescored")
        self.assertEqual([r["key"] for r in out["newly_expired"]], ["other"])
        self.assertEqual(out["swept"], 1)
        self.assertEqual(self.read_state()["new_past"]["status"], "new")

    def test_without_write_nothing_is_persisted(self):
        self.write_state({"past": entry(status="ranked", deadline="2026-09-01")})
        out = self.run_tool("sweep")
        self.assertEqual([r["key"] for r in out["newly_expired"]], ["past"])
        self.assertFalse(out["written"])
        self.assertEqual(self.read_state()["past"]["status"], "ranked")


class Apply(RankStateCase):
    def test_scored_keys_keep_past_deadlines_out_of_the_shortlist(self):
        for status in ("new", "ranked", "expired"):
            with self.subTest(status=status):
                original = entry(status=status, deadline="2026-09-02")
                if status != "new":
                    original.update(rank_score=61, rank_date="2026-08-31", strengths=["stored strength"])
                self.write_state({"a": original})
                args = ["candidates", "--tracker", str(self.tmp / "none.csv")]
                if status != "new":
                    args.append("--all")
                selected = self.run_tool(*args)["selected"]
                self.assertEqual([row["key"] for row in selected], ["a"])
                result = {"key": "a", "status": "scored", "deadline": None,
                          "scores": {dimension: 80 for dimension in ("technical", "experience", "behavioral", "career")},
                          "location_verdict": "PASS", "language_gate": "PASS", "posting_language": "en",
                          "strengths": ["fresh strength"], "gaps": []}
                out = self.run_tool("apply", "--results", self.results([result]))
                self.assertEqual(out["ranked"], [])
                self.assertEqual(out["vetoed"], [])
                self.assertEqual([row["key"] for row in out["expired"]], ["a"])
                self.assertEqual(self.read_state()["a"], dict(original, status="expired"))
                swept = self.run_tool("sweep", "--write", "--exclude", "a")
                self.assertEqual(swept["swept"], 0)
                self.assertEqual(self.read_state()["a"]["status"], "expired")

    def test_deadline_apply_boundaries_and_dry_run_keep_existing_semantics(self):
        cases = [
            (TODAY, None, "scored", "ranked"),
            ("2026-09-04", None, "scored", "ranked"),
            ("ASAP", None, "scored", "ranked"),
            (None, None, "scored", "ranked"),
            ("2026-09-02", "2026-09-04", "scored", "ranked"),
            (None, None, "expired", "expired"),
            ("2026-09-02", None, "scored", "expired"),
        ]
        for stored, fresh, status, expected in cases:
            with self.subTest(stored=stored, fresh=fresh, status=status):
                self.write_state({"a": entry(deadline=stored)})
                before = self.state.read_bytes()
                result = {"key": "a", "status": status, "deadline": fresh,
                          "scores": {dimension: 80 for dimension in ("technical", "experience", "behavioral", "career")}}
                path = self.results([result])
                dry = self.run_tool("apply", "--results", path, "--dry-run")
                self.assertFalse(dry["written"])
                self.assertEqual(self.state.read_bytes(), before)
                self.assertEqual([row["key"] for row in dry[expected]], ["a"])
                out = self.run_tool("apply", "--results", path)
                self.assertEqual([row["key"] for row in out[expected]], ["a"])
                self.assertEqual(self.read_state()["a"]["status"], expected)
                self.assertEqual(self.read_state()["a"]["deadline"], fresh or stored)

    def test_past_deadline_does_not_bypass_scoring_errors(self):
        for result in ({"key": "a", "status": "scored", "scores": {"technical": 80}},
                       {"key": "missing", "status": "scored", "scores": {}}):
            with self.subTest(result=result):
                original = entry(deadline="2026-09-02")
                self.write_state({"a": original})
                before = self.state.read_bytes()
                path = self.results([result])
                dry = self.run_tool("apply", "--results", path, "--dry-run", expect=1)
                self.assertEqual(len(dry["errors"]), 1)
                self.assertEqual(self.state.read_bytes(), before)
                out = self.run_tool("apply", "--results", path, expect=1)
                self.assertEqual(len(out["errors"]), 1)
                self.assertEqual(out["expired"], [])
                self.assertEqual(self.read_state()["a"], original)

    def test_weights_bands_and_persisted_fields(self):
        self.write_state({"a": entry()})
        out = self.run_tool(
            "apply",
            "--results",
            self.results(
                [
                    {
                        "key": "a",
                        "status": "scored",
                        "scores": {"technical": 80, "experience": 60, "behavioral": 70, "career": 75},
                        "location_verdict": "PASS",
                        "language_gate": "PASS",
                        "deadline": "2026-09-05",
                        "strengths": ["s1", "s2"],
                        "gaps": ["g1"],
                    }
                ]
            ),
        )
        stored = self.read_state()["a"]
        # 80*.30 + 60*.25 + 70*.15 + 75*.30 = 72
        self.assertEqual(stored["rank_score"], 72)
        self.assertEqual(stored["rank_verdict"], "Good Fit")
        self.assertEqual(stored["status"], "ranked")
        self.assertEqual(stored["rank_date"], TODAY)
        self.assertEqual(stored["strengths"], ["s1", "s2"])
        self.assertEqual(stored["gaps"], ["g1"])
        self.assertEqual(stored["deadline"], "2026-09-05")
        self.assertTrue(out["ranked"][0]["urgent"], "a deadline inside 7 days carries the urgency marker")

    def test_expired_status_is_written_through(self):
        self.write_state({"a": entry()})
        out = self.run_tool("apply", "--results", self.results([{"key": "a", "status": "expired"}]))
        self.assertEqual(self.read_state()["a"]["status"], "expired")
        self.assertEqual([r["key"] for r in out["expired"]], ["a"])

    def test_null_deadline_does_not_erase_a_stored_one(self):
        """Absence is not a correction: a fetch that degraded to a listing page
        returns no deadline, and blanking the stored date would also put the
        entry out of the sweep's reach forever."""
        self.write_state({"a": entry(deadline="2026-10-01")})
        self.run_tool(
            "apply",
            "--results",
            self.results(
                [
                    {
                        "key": "a",
                        "status": "scored",
                        "scores": {"technical": 50, "experience": 50, "behavioral": 50, "career": 50},
                        "deadline": None,
                    }
                ]
            ),
        )
        self.assertEqual(self.read_state()["a"]["deadline"], "2026-10-01")

    def test_legacy_verdict_stored_under_location_is_migrated(self):
        self.write_state({"a": entry(location="FLAG")})
        self.run_tool(
            "apply",
            "--results",
            self.results(
                [
                    {
                        "key": "a",
                        "status": "scored",
                        "scores": {"technical": 50, "experience": 50, "behavioral": 50, "career": 50},
                    }
                ]
            ),
        )
        stored = self.read_state()["a"]
        self.assertEqual(stored["location_verdict"], "FLAG")
        self.assertNotIn("location", stored, "a legacy verdict is moved, never left to read as a place")

    def test_a_real_place_in_location_survives(self):
        self.write_state({"a": entry(location="Athens, Greece")})
        self.run_tool(
            "apply",
            "--results",
            self.results(
                [
                    {
                        "key": "a",
                        "status": "scored",
                        "scores": {"technical": 50, "experience": 50, "behavioral": 50, "career": 50},
                        "location_verdict": "PASS",
                    }
                ]
            ),
        )
        self.assertEqual(self.read_state()["a"]["location"], "Athens, Greece")

    def test_vetoed_rows_are_separated_from_the_ranking(self):
        self.write_state({"a": entry(), "b": entry(), "c": entry()})
        scores = {"technical": 90, "experience": 90, "behavioral": 90, "career": 90}
        out = self.run_tool(
            "apply",
            "--results",
            self.results(
                [
                    {"key": "a", "status": "scored", "scores": scores, "location_verdict": "FAIL"},
                    {"key": "b", "status": "scored", "scores": scores, "language_gate": "FAIL",
                     "language_note": "requires fluent Polish"},
                    {"key": "c", "status": "scored", "scores": {"technical": 40, "experience": 40,
                                                                "behavioral": 40, "career": 40}},
                ]
            ),
        )
        self.assertEqual(sorted(r["key"] for r in out["vetoed"]), ["a", "b"])
        self.assertEqual([r["key"] for r in out["ranked"]], ["c"])
        self.assertEqual(self.read_state()["b"]["language_note"], "requires fluent Polish")

    def test_language_note_is_dropped_when_gate_passes(self):
        self.write_state({"a": entry(language_note="stale note from a prior run")})
        self.run_tool(
            "apply",
            "--results",
            self.results(
                [
                    {
                        "key": "a",
                        "status": "scored",
                        "scores": {"technical": 50, "experience": 50, "behavioral": 50, "career": 50},
                        "language_gate": "PASS",
                    }
                ]
            ),
        )
        self.assertNotIn("language_note", self.read_state()["a"])

    def test_strengths_and_gaps_are_capped_and_stored_verbatim(self):
        self.write_state({"a": entry()})
        self.run_tool(
            "apply",
            "--results",
            self.results(
                [
                    {
                        "key": "a",
                        "status": "scored",
                        "scores": {"technical": 50, "experience": 50, "behavioral": 50, "career": 50},
                        "strengths": ["one", "two", "three", "four"],
                        "gaps": ["<script>not sanitized on purpose, stored as plain data</script>"],
                    }
                ]
            ),
        )
        stored = self.read_state()["a"]
        self.assertEqual(len(stored["strengths"]), 3, "at most 3 bullets, matching the spec")
        self.assertEqual(
            stored["gaps"],
            ["<script>not sanitized on purpose, stored as plain data</script>"],
            "gaps are stored verbatim - untrusted data, never reformatted",
        )

    def test_all_replaces_rather_than_accumulates_arrays(self):
        self.write_state({"a": entry(status="ranked", strengths=["old strength"], gaps=["old gap"])})
        self.run_tool(
            "apply",
            "--results",
            self.results(
                [
                    {
                        "key": "a",
                        "status": "scored",
                        "scores": {"technical": 50, "experience": 50, "behavioral": 50, "career": 50},
                        "strengths": ["new strength"],
                        "gaps": ["new gap"],
                    }
                ]
            ),
        )
        stored = self.read_state()["a"]
        self.assertEqual(stored["strengths"], ["new strength"])
        self.assertEqual(stored["gaps"], ["new gap"])

    def test_unknown_key_is_an_error_not_a_silent_drop(self):
        self.write_state({"a": entry()})
        out = self.run_tool(
            "apply", "--results", self.results([{"key": "ghost", "status": "scored", "scores": {}}]), expect=1
        )
        self.assertEqual(out["errors"][0]["key"], "ghost")

    def test_missing_score_dimension_is_an_error(self):
        self.write_state({"a": entry()})
        out = self.run_tool(
            "apply",
            "--results",
            self.results([{"key": "a", "status": "scored", "scores": {"technical": 80}}]),
            expect=1,
        )
        self.assertIn("experience", out["errors"][0]["error"])
        self.assertEqual(self.read_state()["a"]["status"], "new", "a rejected result never half-writes an entry")

    def test_dry_run_prints_but_never_writes(self):
        self.write_state({"a": entry()})
        self.run_tool(
            "apply",
            "--results",
            self.results(
                [{"key": "a", "status": "scored",
                  "scores": {"technical": 50, "experience": 50, "behavioral": 50, "career": 50}}]
            ),
            "--dry-run",
        )
        self.assertEqual(self.read_state()["a"]["status"], "new")

    def test_invalid_scores_report_errors_without_changing_the_entry(self):
        dimensions = ("technical", "experience", "behavioral", "career")
        invalid = (-1, 101, True, False, float("nan"), float("inf"), -float("inf"), 10**400)
        for dimension in dimensions:
            for value in invalid:
                with self.subTest(dimension=dimension, value=value):
                    original = entry(status="ranked", rank_score=70, strengths=["keep"])
                    self.write_state({"a": original, "b": entry()})
                    scores = dict.fromkeys(dimensions, 50)
                    scores[dimension] = value
                    out = self.run_tool(
                        "apply", "--results", self.results([
                            {"key": "a", "status": "scored", "scores": scores},
                            {"key": "b", "status": "scored", "scores": dict.fromkeys(dimensions, 80)},
                        ]), expect=1,
                    )
                    self.assertEqual(len(out["errors"]), 1)
                    self.assertEqual(out["errors"][0]["key"], "a")
                    self.assertIn(dimension, out["errors"][0]["error"])
                    self.assertEqual(self.read_state()["a"], original)
                    self.assertEqual([row["key"] for row in out["ranked"]], ["b"])
                    self.assertEqual(self.read_state()["b"]["rank_score"], 80)

    def test_score_boundaries_and_fractional_scores_remain_valid(self):
        for value, expected in ((0, 0), (100, 100), (72.5, 73)):
            with self.subTest(value=value):
                self.write_state({"a": entry()})
                out = self.run_tool("apply", "--results", self.results([
                    {"key": "a", "status": "scored", "scores": dict.fromkeys(
                        ("technical", "experience", "behavioral", "career"), value)},
                ]))
                self.assertEqual(out["errors"], [])
                self.assertEqual(self.read_state()["a"]["rank_score"], expected)

    def test_re_scoring_an_already_ranked_job_is_idempotent(self):
        """Re-running /rank never re-scores an already-ranked job unless --all
        says so (Step 4), but if it does score one again, apply must produce
        the same result deterministically rather than accumulating state."""
        self.write_state({"a": entry(status="ranked", rank_score=40, strengths=["old"])})
        scores = {"technical": 90, "experience": 90, "behavioral": 90, "career": 90}
        self.run_tool(
            "apply", "--results",
            self.results([{"key": "a", "status": "scored", "scores": scores, "strengths": ["new"]}]),
        )
        stored = self.read_state()["a"]
        self.assertEqual(stored["rank_score"], 90)
        self.assertEqual(stored["strengths"], ["new"])

    # --- posting_guard verdict (`guard`): additive, optional, ported from upstream ---
    # The scoring agent runs tools/posting_guard.py on each fetched body and
    # returns the gate's verdict line as `guard`.

    def test_apply_persists_guard_verdict(self):
        verdict = "posting_guard: \u26a0 1 instruction-like line - review before continuing (1 hidden block removed)"
        stored = "\u26a0 1 instruction-like line - review before continuing (1 hidden block removed)"
        self.write_state({"a": entry(status="new"), "b": entry(status="new")})
        out = self.run_tool("apply", "--results", self.results([
            scored(guard=verdict),
            scored(key="b", guard="clean", location_verdict="FAIL"),
        ]))
        self.assertEqual(self.read_state()["a"]["guard"], stored)
        self.assertEqual(out["ranked"][0]["guard"], stored)
        self.assertEqual(self.read_state()["b"]["guard"], "clean")
        self.assertEqual(out["vetoed"][0]["guard"], "clean")

    def test_apply_without_guard_key_unchanged(self):
        self.write_state({"a": entry(status="new")})
        out = self.run_tool("apply", "--results", self.results([scored()]))
        self.assertNotIn("guard", self.read_state()["a"])
        self.assertIsNone(out["ranked"][0]["guard"])

    def test_apply_normalises_the_guard_verdict(self):
        self.write_state({k: entry(status="new") for k in "abc"})
        out = self.run_tool("apply", "--results", self.results([
            scored(key="a", guard="posting_guard: clean"),
            scored(key="b", guard="posting_guard: clean (8 hidden blocks removed, none instruction-like)"),
            scored(key="c", guard="posting_guard: \u26a0 1 instruction-like line - review before continuing"),
        ]))
        state = self.read_state()
        self.assertEqual(state["a"]["guard"], "clean")
        self.assertEqual(state["b"]["guard"], "clean")
        self.assertEqual(state["c"]["guard"], "\u26a0 1 instruction-like line - review before continuing")
        self.assertEqual({row["key"]: row["guard"] for row in out["ranked"]}["c"], state["c"]["guard"])

    def test_apply_drops_a_stale_guard_when_rescored_without_one(self):
        self.write_state({"a": entry(status="ranked", guard="\u26a0 old", rank_score=50, rank_date="2026-08-01")})
        out = self.run_tool("apply", "--results", self.results([scored()]))
        self.assertNotIn("guard", self.read_state()["a"])
        self.assertIsNone(out["ranked"][0]["guard"])

    def test_apply_truncates_and_rejects_non_string_guard(self):
        self.write_state({"a": entry(status="new"), "b": entry(status="new")})
        out = self.run_tool("apply", "--results", self.results([
            scored(guard="x" * 500),
            scored(key="b", guard={"not": "a string"}),
        ]))
        self.assertEqual(len(self.read_state()["a"]["guard"]), 200)
        self.assertNotIn("guard", self.read_state()["b"])
        self.assertIsNone([r for r in out["ranked"] if r["key"] == "b"][0]["guard"])


def scored(key="a", **over):
    base = {
        "key": key,
        "status": "scored",
        "deadline": None,
        "scores": {d: 70 for d in ("technical", "experience", "behavioral", "career")},
        "location_verdict": "PASS",
        "language_gate": "PASS",
        "posting_language": "es",
        "strengths": ["s"],
        "gaps": ["g"],
    }
    base.update(over)
    return base


class SalaryModalityFreshness(RankStateCase):
    """Fields the local dashboard filters on (10-ats-and-screening.md)."""

    def results(self, payload):
        path = self.tmp / "results.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return str(path)

    def test_usd_yearly_range_converts_to_mxn_month_midpoint(self):
        self.write_state({"a": entry()})
        salary = {"min": 48000, "max": 60000, "currency": "usd", "period": "year"}
        self.run_tool("apply", "--results", self.results([scored(salary=salary)]))
        stored = self.read_state()["a"]
        self.assertEqual(stored["salary_currency"], "USD")
        self.assertEqual(stored["salary_period"], "year")
        self.assertEqual(stored["salary_mxn_month"], round(54000 / 12 * 18.5))

    def test_custom_fx_and_single_bound(self):
        self.write_state({"a": entry()})
        salary = {"min": None, "max": 4000, "currency": "EUR", "period": "month"}
        self.run_tool("apply", "--results", self.results([scored(salary=salary)]), "--fx", "EUR=20")
        self.assertEqual(self.read_state()["a"]["salary_mxn_month"], 80000)

    def test_unknown_currency_is_never_converted(self):
        self.write_state({"a": entry()})
        salary = {"min": 1000, "max": 2000, "currency": "COP", "period": "month"}
        self.run_tool("apply", "--results", self.results([scored(salary=salary)]))
        stored = self.read_state()["a"]
        self.assertEqual(stored["salary_min"], 1000)
        self.assertIsNone(stored["salary_mxn_month"])

    def test_no_salary_stated_stores_nulls(self):
        self.write_state({"a": entry()})
        self.run_tool("apply", "--results", self.results([scored(salary=None)]))
        stored = self.read_state()["a"]
        self.assertIsNone(stored["salary_min"])
        self.assertIsNone(stored["salary_mxn_month"])

    def test_modality_and_fit_reasons_persist(self):
        self.write_state({"a": entry()})
        reasons = ["Pide Python y ETL, tu stack principal.", "Remoto LatAm.", "x", "y", "z"]
        self.run_tool("apply", "--results", self.results([scored(modality="Remote", fit_reasons=reasons)]))
        stored = self.read_state()["a"]
        self.assertEqual(stored["modality"], "remote")
        self.assertEqual(stored["fit_reasons"], reasons[:4])

    def test_unknown_modality_falls_back(self):
        self.write_state({"a": entry()})
        self.run_tool("apply", "--results", self.results([scored(modality="on the moon")]))
        self.assertEqual(self.read_state()["a"]["modality"], "unknown")

    def test_fresh_posting_outranks_stale_one_with_same_score(self):
        self.write_state({
            "old": entry(posted_date="2026-08-01"),
            "new": entry(title="Data Engineer", posted_date="2026-09-01T10:00:00Z"),
        })
        out = self.run_tool("apply", "--results", self.results([scored("old"), scored("new")]))
        self.assertEqual([r["key"] for r in out["ranked"]], ["new", "old"])
        by_key = {r["key"]: r for r in out["ranked"]}
        self.assertTrue(by_key["new"]["fresh"])
        self.assertEqual(by_key["new"]["age_days"], 2)
        self.assertFalse(by_key["old"]["fresh"])
        self.assertEqual(by_key["new"]["score"], by_key["old"]["score"])
        self.assertGreater(by_key["new"]["priority_score"], by_key["old"]["priority_score"])

    def test_fresh_days_window_is_configurable(self):
        self.write_state({"a": entry(posted_date="2026-08-27")})
        out = self.run_tool("apply", "--results", self.results([scored()]), "--fresh-days", "7")
        self.assertTrue(out["ranked"][0]["fresh"])

    def test_missing_posted_date_gets_no_adjustment(self):
        self.write_state({"a": entry()})
        out = self.run_tool("apply", "--results", self.results([scored()]))
        row = out["ranked"][0]
        self.assertIsNone(row["age_days"])
        self.assertEqual(row["priority_score"], row["score"])


class PostingLanguage(RankStateCase):
    """`posting_language` and the strict English-posting rule (04-job-evaluation.md)."""

    def apply(self, **over):
        self.write_state({"a": entry()})
        path = self.tmp / "results.json"
        path.write_text(json.dumps([scored(**over)]), encoding="utf-8")
        out = self.run_tool("apply", "--results", str(path))
        return self.read_state()["a"], (out["ranked"] + out["vetoed"])[0]

    def test_spanish_posting_is_persisted_and_not_flagged(self):
        stored, row = self.apply(posting_language="es")
        self.assertEqual(stored["posting_language"], "es")
        self.assertEqual(row["posting_language"], "es")
        self.assertEqual(stored["language_gate"], "PASS")
        self.assertNotIn("language_note", stored)

    def test_english_posting_is_flagged_even_if_agent_said_pass(self):
        stored, _ = self.apply(posting_language="EN", language_gate="PASS", gaps=["g"])
        self.assertEqual(stored["posting_language"], "en")
        self.assertEqual(stored["language_gate"], "FLAG")
        self.assertEqual(stored["language_note"], "La vacante está escrita en inglés: probablemente se requiere inglés hablado.")
        self.assertIn("Inglés hablado", stored["gaps"])
        self.assertEqual(sum("inglés hablado" in g.lower() for g in stored["gaps"]), 1)

    def test_english_posting_keeps_agent_note_and_gap_and_caps_gaps_at_three(self):
        stored, _ = self.apply(
            posting_language="en", language_gate="FLAG", language_note="agent note",
            gaps=["spoken English: asked", "b", "c"],
        )
        self.assertEqual(stored["language_note"], "agent note")
        self.assertEqual(stored["gaps"], ["spoken English: asked", "b", "c"])
        stored, _ = self.apply(posting_language="en", gaps=["a", "b", "c"])
        self.assertEqual(len(stored["gaps"]), 3)
        self.assertIn("Inglés hablado", stored["gaps"][0])
        self.assertEqual(len(stored["gaps"]), 3)

    def test_english_posting_never_softens_a_fail(self):
        stored, _ = self.apply(posting_language="en", language_gate="FAIL", language_note="Polish")
        self.assertEqual(stored["language_gate"], "FAIL")

    def test_mixed_posting_is_not_flagged(self):
        stored, _ = self.apply(posting_language="mixed")
        self.assertEqual(stored["posting_language"], "mixed")
        self.assertEqual(stored["language_gate"], "PASS")

    def test_invalid_or_missing_value_is_not_stored(self):
        stored, _ = self.apply(posting_language="klingon")
        self.assertNotIn("posting_language", stored)
        stored, _ = self.apply(posting_language=None)
        self.assertNotIn("posting_language", stored)


if __name__ == "__main__":
    unittest.main()
