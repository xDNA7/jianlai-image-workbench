import os
import pathlib
import subprocess
import tempfile
import unittest


class PinnedScannerTests(unittest.TestCase):
    def reject_modified_asset(self, primary_fails):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            tools = root / 'tools'
            tools.mkdir()
            curl = tools / 'curl'
            curl.write_text('#!/bin/sh\n' + ('exit 22\n' if primary_fails else 'for last; do :; done\nprintf changed-archive > "$last"\n'))
            curl.chmod(0o755)
            gh = tools / 'gh'
            gh.write_text('#!/bin/sh\nprintf changed-api-archive\n')
            gh.chmod(0o755)
            destination = root / 'scanner'
            result = subprocess.run(
                ['sh', str(pathlib.Path(__file__).with_name('install-gitleaks.sh')), str(destination)],
                env={**os.environ, 'PATH': str(tools) + os.pathsep + os.environ['PATH']},
                capture_output=True, text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('FAILED', result.stdout)
            self.assertFalse(destination.exists())

    def test_primary_download_still_requires_pinned_checksum(self):
        self.reject_modified_asset(False)

    def test_api_fallback_still_requires_pinned_checksum(self):
        self.reject_modified_asset(True)


if __name__ == '__main__':
    unittest.main()
