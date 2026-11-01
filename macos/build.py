"""Build a self-contained Apple Silicon app from an explicit source allowlist."""
import hashlib,os,plistlib,shutil,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'dist';BUILD=ROOT/'build/macos';APP=OUT/'链路盒子.app'
if sys.platform!='darwin':raise SystemExit('Build the Mac package on macOS.')
OUT.mkdir(exist_ok=True);BUILD.mkdir(parents=True,exist_ok=True)
subprocess.run([sys.executable,'-m','PyInstaller','--noconfirm','--clean','--onedir','--name','linkbox-backend','--distpath',str(BUILD/'backend'),'--workpath',str(BUILD/'work'),'--specpath',str(BUILD),'--add-data',str(ROOT/'macos/backend/check.html')+':.','--collect-data','certifi','--hidden-import','subscription_update',str(ROOT/'macos/backend/gui_backend.py')],check=True)
if APP.exists():shutil.rmtree(APP)
contents=APP/'Contents';(contents/'MacOS').mkdir(parents=True);(contents/'Resources').mkdir()
shutil.copytree(BUILD/'backend/linkbox-backend',contents/'Resources/backend')
shutil.copy2(ROOT/'assets/ProxyToolbox.icns',contents/'Resources/ProxyToolbox.icns')
subprocess.run(['xcrun','swiftc','-O','-target','arm64-apple-macosx13.0','-framework','AppKit','-framework','WebKit',str(ROOT/'macos/Toolbox.swift'),'-o',str(contents/'MacOS/ProxyToolbox')],check=True)
info={'CFBundleDisplayName':'链路盒子','CFBundleExecutable':'ProxyToolbox','CFBundleIconFile':'ProxyToolbox.icns','CFBundleIdentifier':'local.solomon.proxytoolbox','CFBundleName':'链路盒子','CFBundlePackageType':'APPL','CFBundleShortVersionString':'1.1.0','CFBundleVersion':'110','LSMinimumSystemVersion':'13.0','NSHighResolutionCapable':True,'NSRequiresAquaSystemAppearance':True}
(contents/'Info.plist').write_bytes(plistlib.dumps(info))
shutil.copytree(ROOT/'examples',contents/'Resources/examples')
subprocess.run(['codesign','--force','--deep','--sign','-',str(APP)],check=True)
subprocess.run(['codesign','--verify','--deep','--strict',str(APP)],check=True)
subprocess.run([str(contents/'Resources/backend/linkbox-backend'),'self-test'],check=True)
zipfile=OUT/'linkbox-macos-arm64.zip';zipfile.unlink(missing_ok=True)
subprocess.run(['ditto','-c','-k','--sequesterRsrc','--keepParent',str(APP),str(zipfile)],check=True)
zipfile.with_suffix('.zip.sha256').write_text(hashlib.sha256(zipfile.read_bytes()).hexdigest()+'  '+zipfile.name+'\n')
print(zipfile)
