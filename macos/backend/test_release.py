import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'check_release', Path(__file__).resolve().parents[2] / 'scripts/check-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseChecks(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(TemporaryDirectory())
        self.root = Path(directory)
        (self.root / 'windows').mkdir()
        (self.root / 'docs').mkdir()
        (self.root / 'windows/package.json').write_text('{"version":"1.3.0"}')
        self.lock = self.root / 'windows/package-lock.json'
        self.write_lock('1.3.0', '1.3.0')

    def write_lock(self, top, root):
        self.lock.write_text(json.dumps({'version': top, 'packages': {'': {'version': root}}}))

    def test_valid_version_and_tag(self):
        (self.root / 'docs/release-v1.3.0.md').touch()
        self.assertEqual(release.check_release(self.root, 'v1.3.0'), '1.3.0')

    def test_version_mismatch(self):
        for top, root in [('1.2.0', '1.3.0'), ('1.3.0', '1.2.0')]:
            with self.subTest(top=top, root=root):
                self.write_lock(top, root)
                with self.assertRaisesRegex(ValueError, 'package-lock.json'):
                    release.check_release(self.root)
        self.write_lock('1.3.0', '1.3.0')
        for key, label in [('CFBundleShortVersionString', 'short version'), ('CFBundleVersion', 'build number')]:
            with self.subTest(key=key):
                info = release.bundle_info(self.root)
                info[key] = '99'
                with patch.object(release, 'bundle_info', return_value=info):
                    with self.assertRaisesRegex(ValueError, label):
                        release.check_release(self.root)

    def test_tag_mismatch(self):
        (self.root / 'docs/release-v1.2.0.md').touch()
        with self.assertRaisesRegex(ValueError, 'does not match'):
            release.check_release(self.root, 'v1.2.0')

    def test_missing_release_notes(self):
        with self.assertRaisesRegex(ValueError, 'Missing release notes'):
            release.check_release(self.root, 'v1.3.0')
