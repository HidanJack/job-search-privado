"""A `.not-upstream` file marks a derived edition: upstream-only guards must not assume upstream."""
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _upstream  # noqa: E402


class NotUpstreamMarker(unittest.TestCase):
    def test_marker_means_not_upstream_even_without_a_git_origin(self):
        with TemporaryDirectory() as d:
            marker = Path(d) / ".not-upstream"
            marker.write_text("derived edition\n")
            with mock.patch.object(_upstream, "NOT_UPSTREAM_MARKER", marker), mock.patch.object(_upstream, "REPO", Path(d)):
                self.assertFalse(_upstream.is_upstream_checkout())

    def test_without_marker_or_origin_upstream_is_still_assumed(self):
        with TemporaryDirectory() as d:
            with mock.patch.object(_upstream, "NOT_UPSTREAM_MARKER", Path(d) / ".not-upstream"), mock.patch.object(_upstream, "REPO", Path(d)), mock.patch.dict("os.environ", {}, clear=False):
                import os
                os.environ.pop("GITHUB_REPOSITORY", None)
                self.assertTrue(_upstream.is_upstream_checkout())


if __name__ == "__main__":
    unittest.main()
