"""Fork-specific wiring of the posting gate: pieces upstream does not have.

- /apply in [ui-mode] cannot ask "Continue with this posting?", so a flagged
  verdict must stop the run with stage "error" and a Spanish message.
- /apply and /rank dispatch the shipped write-less agents, not general-purpose.
- Indeed MCP output (not covered upstream) also goes through the gate.
- settings.json ships ask/deny rules and does not widen the headless flows.
"""
import json
import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
APPLY = (REPO / ".claude" / "commands" / "apply.md").read_text(encoding="utf-8")
RANK = (REPO / ".claude" / "commands" / "rank.md").read_text(encoding="utf-8")


class ApplyWiring(unittest.TestCase):
    def test_ui_mode_stops_on_a_flagged_verdict(self):
        block = re.search(r"\*\*Non-interactive mode.*?(?=\n---)", APPLY, re.DOTALL).group(0)
        self.assertIn("posting_guard", block)
        self.assertIn('"stage": "error"', block)
        self.assertIn("Spanish", block)
        self.assertRegex(block, r"instruction-like")

    def test_agents_are_the_shipped_write_less_ones(self):
        self.assertIn("subagent_type: posting-fetcher", APPLY)
        self.assertIn("subagent_type: application-reviewer", APPLY)
        self.assertNotIn("general-purpose", APPLY)

    def test_reviewer_returns_research_for_the_orchestrator_to_cache(self):
        self.assertIn("### Company research (for the cache)", APPLY)
        self.assertIn("you have no Write tool", APPLY)
        self.assertIn("**Write the research cache.**", APPLY)

    def test_indeed_still_goes_through_the_mcp(self):
        self.assertIn("get_job_details", APPLY)


class RankWiring(unittest.TestCase):
    def test_indeed_output_is_gated_too(self):
        step2 = re.search(r"## Step 2: Batch-Fetch and Score(.*?)\n## Step 3", RANK, re.DOTALL).group(1)
        self.assertRegex(step2, r"Indeed MCP output[^.]*heredoc")

    def test_expired_status_kept(self):
        self.assertIn('"status": "scored" | "expired"', RANK)
        self.assertNotIn("unreachable", RANK)


class SettingsWiring(unittest.TestCase):
    def setUp(self):
        self.perms = json.loads((REPO / ".claude" / "settings.json").read_text(encoding="utf-8"))["permissions"]

    def test_gate_tools_and_our_own_tools_are_allowed(self):
        allow = set(self.perms["allow"])
        for tool in ("posting_guard", "fetch_page", "robots_check", "prefilter", "opportunity",
                     "posting_language", "rank_state", "scrape_state", "job_key"):
            for py in ("python", "python3"):
                with self.subTest(tool=tool, py=py):
                    self.assertIn(f"Bash({py} tools/{tool}.py:*)", allow)

    def test_ask_rules_only_touch_files_headless_runs_never_edit(self):
        ask = self.perms["ask"]
        self.assertIn("Bash(git push:*)", ask)
        for rule in ask:
            if rule.startswith("Edit("):
                self.assertRegex(rule, r"settings|SKILL\.md|commands|agents|\.github|security_guards")


if __name__ == "__main__":
    unittest.main()
