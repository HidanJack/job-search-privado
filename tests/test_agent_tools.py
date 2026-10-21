"""Tool grants of the shipped agents that read untrusted posting text.

The agents derive from upstream's posting-scorer / posting-fetcher /
application-reviewer. Ours add the two Indeed MCP tools to the scorer and the
fetcher (Indeed MX cannot be fetched any other way) and still never get
Edit, Write, NotebookEdit or Agent.
"""
import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
AGENTS = REPO / ".claude" / "agents"
INDEED = {"mcp__claude_ai_Indeed__get_job_details", "mcp__claude_ai_Indeed__search_jobs"}
WRITERS = {"Edit", "Write", "NotebookEdit", "Agent"}


def tools_of(name: str) -> set:
    text = (AGENTS / name).read_text(encoding="utf-8")
    raw = re.search(r"^tools:\s*(.*)$", text, re.M).group(1)
    return {t.strip() for t in raw.split(",") if t.strip()}


class AgentTools(unittest.TestCase):
    def test_untrusted_text_agents_cannot_write(self):
        for name in ("posting-scorer.md", "posting-fetcher.md", "application-reviewer.md"):
            with self.subTest(agent=name):
                self.assertFalse(tools_of(name) & WRITERS)

    def test_scorer_and_fetcher_can_read_indeed(self):
        for name in ("posting-scorer.md", "posting-fetcher.md"):
            with self.subTest(agent=name):
                self.assertTrue(INDEED <= tools_of(name))
                text = (AGENTS / name).read_text(encoding="utf-8")
                self.assertIn("get_job_details", text)

    def test_agents_require_repo_relative_tool_commands(self):
        # Found in the first real /rank smoke run: the scorer called
        # `python3 /abs/path/tools/posting_guard.py`, which the allow rule
        # `Bash(python3 tools/posting_guard.py:*)` does not match -> denied.
        for name in ("posting-scorer.md", "posting-fetcher.md", "application-reviewer.md"):
            with self.subTest(agent=name):
                text = (AGENTS / name).read_text(encoding="utf-8")
                self.assertRegex(text, r"never (an )?(`python3 /abs/path|absolute path)")

    def test_reviewer_has_no_indeed(self):
        self.assertFalse(INDEED & tools_of("application-reviewer.md"))

    def test_all_three_keep_bash_and_glob(self):
        for name in ("posting-scorer.md", "posting-fetcher.md", "application-reviewer.md"):
            with self.subTest(agent=name):
                self.assertTrue({"Bash", "Glob"} <= tools_of(name))


if __name__ == "__main__":
    unittest.main()
