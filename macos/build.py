"""Build a self-contained Apple Silicon app from an explicit source allowlist."""
import hashlib
import json
import plistlib
import shutil
import subprocess
import sys
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'dist'
BUILD = ROOT / 'build/macos'
APP = OUT / '链路盒子.app'
RESOURCES = [ROOT / 'assets/ProxyToolbox.icns', ROOT / 'windows/coffee-extract.js']
CHECK_PAGE = ROOT / 'macos/backend/check.html'
REQUIRED_FILES = (
    'MacOS/ProxyToolbox',
    'Resources/backend/linkbox-backend',
    'Resources/backend/_internal/check.html',
    'Resources/ProxyToolbox.icns',
    'Resources/coffee-extract.js',
)


def bundle_info(root=ROOT):
    version = json.loads((root / 'windows/package.json').read_text())['version']
    return {
        'CFBundleDisplayName': '链路盒子',
        'CFBundleExecutable': 'ProxyToolbox',
        'CFBundleIconFile': 'ProxyToolbox.icns',
        'CFBundleIdentifier': 'local.solomon.proxytoolbox',
        'CFBundleName': '链路盒子',
        'CFBundlePackageType': 'APPL',
        'CFBundleShortVersionString': version,
        'CFBundleVersion': version.replace('.', ''),
        'LSMinimumSystemVersion': '13.0',
        'NSHighResolutionCapable': True,
        'NSRequiresAquaSystemAppearance': True,
    }


def check_package(archive, info):
    prefix = f'{APP.name}/Contents/'
    # ditto stores UTF-8 names without the ZIP encoding flag.
    with ZipFile(archive, metadata_encoding='utf-8') as package:
        for name in (*REQUIRED_FILES, 'Info.plist'):
            try:
                entry = package.getinfo(prefix + name)
            except KeyError:
                raise SystemExit(f'Missing required app file: {name}') from None
            if entry.is_dir() or not entry.file_size:
                raise SystemExit(f'Empty required app file: {name}')
        packaged_info = plistlib.loads(package.read(prefix + 'Info.plist'))
        for key, value in info.items():
            if packaged_info.get(key) != value:
                raise SystemExit(f'Unexpected packaged Info.plist value: {key}')


def main():
    if sys.platform != 'darwin':
        raise SystemExit('Build the Mac package on macOS.')
    info = bundle_info()
    for resource in (*RESOURCES, CHECK_PAGE):
        if not resource.is_file():
            raise SystemExit(f'Missing required app resource: {resource.relative_to(ROOT)}')
    OUT.mkdir(exist_ok=True)
    BUILD.mkdir(parents=True, exist_ok=True)
    subprocess.run([
        sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir',
        '--name', 'linkbox-backend', '--distpath', str(BUILD / 'backend'),
        '--workpath', str(BUILD / 'work'), '--specpath', str(BUILD),
        '--add-data', str(CHECK_PAGE) + ':.', '--collect-data', 'certifi',
        '--hidden-import', 'subscription_update', '--hidden-import', 'subscription_picker',
        str(ROOT / 'macos/backend/gui_backend.py'),
    ], check=True)
    if APP.exists():
        shutil.rmtree(APP)
    contents = APP / 'Contents'
    (contents / 'MacOS').mkdir(parents=True)
    (contents / 'Resources').mkdir()
    shutil.copytree(BUILD / 'backend/linkbox-backend', contents / 'Resources/backend')
    for resource in RESOURCES:
        shutil.copy2(resource, contents / 'Resources' / resource.name)
    subprocess.run([
        'xcrun', 'swiftc', '-O', '-target', 'arm64-apple-macosx13.0',
        '-framework', 'AppKit', '-framework', 'WebKit', str(ROOT / 'macos/Toolbox.swift'),
        '-o', str(contents / 'MacOS/ProxyToolbox'),
    ], check=True)
    (contents / 'Info.plist').write_bytes(plistlib.dumps(info))
    shutil.copytree(ROOT / 'examples', contents / 'Resources/examples')
    subprocess.run(['codesign', '--force', '--deep', '--sign', '-', str(APP)], check=True)
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(APP)], check=True)
    subprocess.run([str(contents / 'Resources/backend/linkbox-backend'), 'self-test'], check=True)
    archive = OUT / 'linkbox-macos-arm64.zip'
    archive.unlink(missing_ok=True)
    subprocess.run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(APP), str(archive)], check=True)
    check_package(archive, info)
    archive.with_suffix('.zip.sha256').write_text(
        hashlib.sha256(archive.read_bytes()).hexdigest() + '  ' + archive.name + '\n')
    print(archive)


if __name__ == '__main__':
    main()
