"""Fail if a public source tree contains personal runtime state or likely subscription tokens."""
from pathlib import Path
import re,subprocess
root=Path(__file__).resolve().parents[1]
files=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard'],cwd=root,text=True).splitlines()
violations=[]
for name in files:
    p=root/name
    if not p.is_file() or p.suffix in {'.png','.ico','.icns'}:continue
    text=p.read_text(errors='replace')
    if re.search(r'https?://[^\s"\']+/(?:api/v\d+/client|subscribe)/[a-fA-F0-9]{20,}',text):violations.append(name+': subscription URL')
    if re.search(r'(?m)^\s*(?:password|uuid):\s*[\'\"]?(?!CHANGE_ME|YOUR_|example)[A-Za-z0-9_-]{12,}',text):violations.append(name+': credential')
    if name.endswith(('results.json','profiles.yaml','clash-verge.yaml')):violations.append(name+': runtime state')
if violations:raise SystemExit('\n'.join(violations))
print('Public source allowlist and credential-pattern checks passed')
