import os
import subprocess
import unittest
import tempfile
import zipfile
from pathlib import Path
from unittest.mock import patch

from publish_release import main, release, package_setup


class ReleasePublishingTests(unittest.TestCase):
    def test_setup_bundle_excludes_private_key_and_login_state(self):
        root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "setup.zip"
            package_setup(root, "0.1.4", destination)
            with zipfile.ZipFile(destination) as archive:
                names = archive.namelist()
                self.assertEqual(len(names), 8)
                self.assertTrue(any(name.endswith("Setup-iPhone-Tunnel.cmd") for name in names))
                self.assertTrue(any(name.endswith("phone-relay.js") for name in names))
                self.assertFalse(any(".env" in name or ".wrangler" in name for name in names))
    def test_never_publishes_from_main_or_pull_request(self):
        for environment in [
            {"GITHUB_REF": "refs/heads/main", "GITHUB_EVENT_NAME": "push"},
            {"GITHUB_REF": "refs/heads/iphone-native", "GITHUB_EVENT_NAME": "pull_request"},
        ]:
            with patch.dict(os.environ, environment, clear=True), patch("publish_release.subprocess.run") as api:
                with self.assertRaisesRegex(RuntimeError, "iphone-native"):
                    main()
                api.assert_not_called()

    def test_missing_release_is_distinct_from_permission_or_network_failure(self):
        missing = subprocess.CompletedProcess([], 1, "", "gh: Not Found (HTTP 404)")
        forbidden = subprocess.CompletedProcess([], 1, "", "gh: Forbidden (HTTP 403)")
        unavailable = subprocess.CompletedProcess([], 1, "", "gh: Service Unavailable (HTTP 503)")
        with patch("publish_release.subprocess.run", return_value=missing):
            self.assertIsNone(release("owner/repo", "ios-v0.1.1"))
        for response in [forbidden, unavailable]:
            with patch("publish_release.subprocess.run", return_value=response):
                with self.assertRaises(RuntimeError):
                    release("owner/repo", "ios-v0.1.1")

    def test_reads_existing_release_for_preservation(self):
        found = subprocess.CompletedProcess([], 0, '{"tag_name":"ios-v0.1.1","assets":[]}', "")
        with patch("publish_release.subprocess.run", return_value=found):
            self.assertEqual(release("owner/repo", "ios-v0.1.1")["tag_name"], "ios-v0.1.1")


if __name__ == "__main__":
    unittest.main()
