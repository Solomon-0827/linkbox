"""Discover local Clash Verge subscriptions; expose names only to the picker UI."""
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urlsplit
import yaml
import runtime
import toolbox as t
import subscription_update as update
from reconcile import reconcile, selection_owners

PREVIEW = 'subscription-preview.yaml'


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def document(raw):
    try:
        value = yaml.safe_load(raw) if raw is not None else None
        return value if isinstance(value, dict) else {}
    except (ValueError, yaml.YAMLError):
        return {}


def source_key(url):
    # Providers can rotate domains while keeping the same opaque subscription ID.
    parsed = urlsplit(url)
    if re.search(r'/(?:client|subscribe)/[A-Za-z0-9_-]{20,}$', parsed.path):
        return parsed.path + '?' + parsed.query
    return url


def discover(for_update=False):
    root = runtime.CONFIG_DIR
    profiles = document(update.read(root / 'profiles.yaml'))
    items = profiles.get('items')
    if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
        raise RuntimeError('无法完整读取 Clash Verge 订阅，未删除节点')
    # The saved registry can preserve IDs, but only Verge can list sources.
    registry = runtime.read_json('subscriptions.json').get('sources', [])
    by_url = {source_key(s['url']): s for s in registry if s.get('url')}
    sources = []
    seen = set()
    for item in items:
        if item.get('type') != 'remote':
            continue
        if not isinstance(item.get('url'), str) or not item['url'].startswith('https://') or not item.get('file'):
            if for_update:
                raise RuntimeError('Clash Verge 订阅需要 HTTPS 地址及本地文件，未更新节点')
            continue
        # Only read local profile files under the known directory.
        filename = item.get('file', '')
        if not isinstance(filename, str) or Path(filename).name != filename or filename in {'.', '..'} or '\\' in filename:
            if for_update:
                raise RuntimeError('Clash Verge 订阅路径无效，未删除节点')
            continue
        old = by_url.get(source_key(item['url']), {})
        identifier = old.get('name') or 'verge_' + hashlib.sha256(str(item.get('uid', filename)).encode()).hexdigest()[:12]
        profile = root / 'profiles' / filename
        source = {'name': identifier, 'display_name': item.get('name') or identifier,
                  'url': item['url'], 'profile_file': filename}
        key = source_key(item['url'])
        if key in seen:
            continue
        seen.add(key)
        sources.append((source, update.read(profile)))
    if len({s['name'] for s, _ in sources}) != len(sources):
        raise RuntimeError('订阅标识冲突，请先整理 Clash Verge 订阅')
    revisions = [[source, None if raw is None else hashlib.sha256(raw).hexdigest()] for source, raw in sources]
    revision = fingerprint([str(root), revisions, runtime.read_json('node-policy.json')])
    if for_update:
        return [(source, None) for source, _ in sources], revision, False
    raw_preview = update.read(runtime.BASE / PREVIEW)
    preview = document(raw_preview)
    use_preview = preview.get('revision') == revision
    inventory = [(source, preview['documents'][source['name']] if use_preview
                  else clean(document(raw), source['display_name'])) for source, raw in sources]
    return inventory, fingerprint([revision, hashlib.sha256(raw_preview).hexdigest() if use_preview else None]), use_preview


def clean(doc, label):
    nodes = []
    names = set()
    entries = doc.get('proxies')
    for n in entries if isinstance(entries, list) else []:
        if (not isinstance(n, dict) or not isinstance(n.get('name'), str)
                or not all(n.get(k) for k in ('name', 'type', 'server', 'port'))):
            continue
        if n['name'] in (t.ENTRY, t.EXIT, 'DIRECT', 'REJECT') or update.NOTICE.search(n['name']):
            continue
        if n['name'] in names:
            raise RuntimeError('订阅含重名节点，请先在 Clash Verge 修复：' + label)
        names.add(n['name'])
        nodes.append(n)
    return {**doc, 'proxies': nodes}


def plan(sources, selection, state, metric='chain', results=None):
    inventory = [{'id': source['name'], 'nodes': [n['name'] for n in doc['proxies']]}
                 for source, doc in sources]
    return reconcile(inventory, selection, state['live'], state['entry'], metric, results)


def catalog():
    sources, fingerprint, _ = discover()
    state = t.relay_state()
    saved = runtime.read_json('node-policy.json').get('selected_nodes')
    owners = selection_owners(plan(sources, saved, state)['selection'])
    current = state['entry']
    current_source = owners.get(current)
    if current_source is None:
        current_source = next((s['name'] for s, doc in sources if any(n['name'] == current for n in doc['proxies'])), None)
    result = []
    for source, doc in sources:
        owner = source['name']
        nodes = [{'name': n['name'], 'type': n['type'], 'selected': owners.get(n['name']) == owner,
                  'current': n['name'] == current and owner == current_source} for n in doc['proxies']]
        result.append({'id': owner, 'name': source['display_name'], 'nodes': nodes,
                       'warning': '' if nodes else '本地暂无可用缓存，请先在 Clash Verge 更新此订阅'})
    return {'sources': result, 'fingerprint': fingerprint, 'current': current}


def validate_selection(sources, fingerprint, request):
    if request.get('fingerprint') != fingerprint or 'current' not in request:
        raise RuntimeError('订阅或筛选已变化，请重新打开管理节点')
    selection = request.get('selected')
    if not isinstance(selection, dict) or set(selection) != {s['name'] for s, _ in sources}:
        raise RuntimeError('节点选择无效，请重新打开管理节点')
    for source, doc in sources:
        values = selection[source['name']]
        available = {n['name'] for n in doc['proxies']}
        if not isinstance(values, list) or any(not isinstance(n, str) or n not in available for n in values):
            raise RuntimeError('订阅节点已变化或格式无效')
    return selection


def apply(request, metric='chain'):
    return update.run(metric, request=request)


def synchronize(metric='chain'):
    return update.run(metric)


def initialize(metric='chain'):
    return update.run(metric, initialize=True)
