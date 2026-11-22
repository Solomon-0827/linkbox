"""Validate package versions and, for a release tag, its notes."""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from macos.build import bundle_info


def check_release(root, tag=None):
    version = json.loads((root / 'windows/package.json').read_text())['version']
    if not isinstance(version, str) or re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version) is None:
        raise ValueError(f'Invalid package version: {version!r}')
    lock = json.loads((root / 'windows/package-lock.json').read_text())
    info = bundle_info(root)
    versions = {
        'package-lock.json version': (lock.get('version'), version),
        'package-lock.json root package version': (lock.get('packages', {}).get('', {}).get('version'), version),
        'macOS short version': (info.get('CFBundleShortVersionString'), version),
        'macOS build number': (info.get('CFBundleVersion'), ''.join(version.split('.'))),
    }
    for label, (actual, expected) in versions.items():
        if actual != expected:
            raise ValueError(f'{label}: expected {expected}, found {actual!r}')
    if tag is not None:
        if tag != f'v{version}':
            raise ValueError(f'Release tag {tag!r} does not match package version {version}')
        notes = root / 'docs' / f'release-{tag}.md'
        if not notes.is_file():
            raise ValueError(f'Missing release notes: {notes.relative_to(root)}')
    return version


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tag', help='Check the release tag and matching notes')
    args = parser.parse_args()
    try:
        version = check_release(ROOT, args.tag)
    except (OSError, KeyError, ValueError) as error:
        parser.exit(1, f'{error}\n')
    print(f'Release checks passed for {version}')


if __name__ == '__main__':
    main()
