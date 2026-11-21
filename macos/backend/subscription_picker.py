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


def digest(raw):
    return None if raw is None else hashlib.sha256(raw).hexdigest()


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


def discover(for_update=False, *, recovering=False):
    root = runtime.CONFIG_DIR
    profiles = document(update.read(root / 'profiles.yaml'))
    items = profiles.get('items')
    if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
        raise RuntimeError('无法完整读取 Clash Verge 订阅，未删除节点')
    # The saved registry can preserve IDs, but only Verge can list sources.
    if recovering:
        try:
            registry = json.loads((runtime.BASE / 'subscriptions.json').read_text())
        except FileNotFoundError:
            registry = {}
        except (OSError, ValueError):
            raise RuntimeError('暂时无法读取订阅记录，请刷新后重试') from None
    else:
        registry = runtime.read_json('subscriptions.json')
    by_url = {source_key(s['url']): s for s in registry.get('sources', []) if s.get('url')}
    sources = []
    seen = set()
    for item in items:
        if item.get('type') != 'remote':
            continue
        if not isinstance(item.get('url'), str) or not item['url'].startswith('https://') or not item.get('file'):
            if for_update or recovering:
                raise RuntimeError('Clash Verge 订阅需要 HTTPS 地址及本地文件，未更新节点')
            continue
        # Only read local profile files under the known directory.
        filename = item.get('file', '')
        if not isinstance(filename, str) or Path(filename).name != filename or filename in {'.', '..'} or '\\' in filename:
            if for_update or recovering:
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
        try:
            raw = update.read(profile)
        except OSError:
            raw = None
        sources.append((source, raw))
    if len({s['name'] for s, _ in sources}) != len(sources):
        raise RuntimeError('订阅标识冲突，请先整理 Clash Verge 订阅')
    revisions = [[source, digest(raw)] for source, raw in sources]
    revision = fingerprint([str(root), revisions, runtime.read_json('node-policy.json')])
    if for_update:
        return [(source, None) for source, _ in sources], revision, None
    raw_preview = update.read(runtime.BASE / PREVIEW)
    preview = document(raw_preview)
    preview_id = digest(raw_preview) if preview.get('revision') == revision else None
    inventory = [(source, preview['documents'][source['name']] if preview_id
                  else clean(document(raw))) for source, raw in sources]
    return inventory, fingerprint([revision, preview_id]), preview_id


def clean(doc):
    nodes = []
    names = set()
    entries = doc.get('proxies')
    if not isinstance(entries, list):
        return None
    for n in entries:
        if (not isinstance(n, dict) or not isinstance(n.get('name'), str)
                or not all(n.get(k) for k in ('name', 'type', 'server', 'port'))):
            return None
        if n['name'] in (t.ENTRY, t.EXIT, 'DIRECT', 'REJECT') or update.NOTICE.search(n['name']):
            continue
        if n['name'] in names:
            return None
        names.add(n['name'])
        nodes.append(n)
    return {**doc, 'proxies': nodes}


def inventory(sources):
    return [{'id': source['name'], 'nodes': [n['name'] for n in doc['proxies']]} if doc is not None
            else {'id': source['name'], 'nodes': [], 'unreadable': True} for source, doc in sources]


def catalog():
    sources, fingerprint, _ = discover()
    state = t.relay_state()
    saved = runtime.read_json('node-policy.json').get('selected_nodes')
    owners = selection_owners(reconcile(inventory(sources), saved, state['live'], state['entry'])['selection'])
    current = state['entry']
    current_source = owners.get(current)
    if current_source is None:
        current_source = next((s['name'] for s, doc in sources if doc is not None
                               and any(n['name'] == current for n in doc['proxies'])), None)
    result = []
    for source, doc in sources:
        owner = source['name']
        if doc is None:
            result.append({'id': owner, 'name': source['display_name'], 'nodes': [],
                           'warning': '本地缓存暂不可读，保留原勾选'})
            continue
        nodes = [{'name': n['name'], 'type': n['type'], 'selected': owners.get(n['name']) == owner,
                  'current': n['name'] == current and owner == current_source} for n in doc['proxies']]
        result.append({'id': owner, 'name': source['display_name'], 'nodes': nodes,
                       'warning': '' if nodes else '本地暂无可用缓存，请先在 Clash Verge 更新此订阅'})
    return {'sources': result, 'fingerprint': fingerprint, 'current': current}


def validate_selection(sources, fingerprint, request, saved):
    if request.get('fingerprint') != fingerprint or 'current' not in request:
        raise RuntimeError('订阅或筛选已变化，请重新打开管理节点')
    selection = request.get('selected')
    if not isinstance(selection, dict) or set(selection) != {s['name'] for s, _ in sources}:
        raise RuntimeError('节点选择无效，请重新打开管理节点')
    selection = selection.copy()
    for source, doc in sources:
        owner = source['name']
        if doc is None:
            if owner in (saved or {}):
                selection[owner] = saved[owner]
            else:
                del selection[owner]
            continue
        values = selection[owner]
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
