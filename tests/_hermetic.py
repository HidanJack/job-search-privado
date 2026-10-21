"""Import first in any test that touches profile-driven tools: pins the profile to a fixture.

The real, gitignored profile_config.json must never change a test outcome.
"""
import os
from pathlib import Path

os.environ["JOB_SEARCH_PROFILE_CONFIG"] = str(Path(__file__).resolve().parent / "fixtures" / "profile_config.test.json")
