import importlib.util
import json
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('native_release', pathlib.Path(__file__).with_name('native_release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class NativeReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.binary = self.root / 'binary'
        self.binary.write_bytes(b'tested-binary')
        self.app = self.root / 'app'
        (self.app / 'public').mkdir(parents=True)
        (self.app / 'public/templates.json').write_text('[]')
        self.base = self.root / 'deploy'

    def stage(self, name):
        return release.stage(self.base, name, self.binary, self.app, release.sha256(self.binary), {'gitSha': 'test'})

    def test_atomic_switch_and_same_database_code_rollback(self):
        one, two = self.stage('one'), self.stage('two')
        self.assertIsNone(release.switch(self.base, one))
        self.assertEqual(release.switch(self.base, two), one)
        self.assertEqual(release.switch(self.base, one), two)
        self.assertEqual((self.base / 'current').resolve(), one)
        self.assertEqual(list(self.base.glob('.current.pending-*')), [])

    def test_rejects_tampering_outside_release_and_overwrite(self):
        one = self.stage('one')
        with self.assertRaises(FileExistsError):
            self.stage('one')
        with self.assertRaises(ValueError):
            self.stage('../escape')
        with self.assertRaises(ValueError):
            release.switch(self.base, self.app)
        (one / 'server').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'changed'):
            release.switch(self.base, one)
        self.assertFalse((self.base / 'current').exists())

    def test_stage_binds_tested_bytes_and_commit_metadata(self):
        with self.assertRaisesRegex(ValueError, 'SHA256'):
            release.stage(self.base, 'bad', self.binary, self.app, '0' * 64, {})
        one = self.stage('one')
        self.assertEqual(json.loads((one / 'release.json').read_text())['gitSha'], 'test')
        self.assertEqual(release.sha256(one / 'server'), release.sha256(self.binary))


if __name__ == '__main__':
    unittest.main()
