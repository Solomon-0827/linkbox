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


def document(path):
    try:
        value = yaml.safe_load(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError, yaml.YAMLError):
        return {}


def source_key(url):
    # Providers can rotate domains while keeping the same opaque subscription ID.
    parsed = urlsplit(url)
    if re.search(r'/(?:client|subscribe)/[A-Za-z0-9_-]{20,}$', parsed.path):
        return parsed.path + '?' + parsed.query
    return url


def discover():
    root = runtime.CONFIG_DIR
    profiles = document(root / 'profiles.yaml')
    config = document(root / 'clash-verge.yaml')
    registry = runtime.read_json('subscriptions.json').get('sources', [])
    by_url = {source_key(s['url']): s for s in registry if s.get('url')}
    sources = []
    seen = set()
    def add(source, doc):
        url = source.get('url', '')
        if source_key(url) in seen or not url.startswith('https://'):
            return
        seen.add(source_key(url))
        nodes = []
        names = set()
        for n in doc.get('proxies', []):
            if not isinstance(n, dict) or not all(n.get(k) for k in ('name','type','server','port')):
                continue
            if n['name'] in (t.ENTRY, t.EXIT, 'DIRECT', 'REJECT') or update.NOTICE.search(n['name']):
                continue
            if n['name'] in names:
                raise RuntimeError('订阅含重名节点，请先在 Clash Verge 修复：' + source['display_name'])
            names.add(n['name']); nodes.append(n)
        sources.append((source, {**doc, 'proxies': nodes}))
    for item in profiles.get('items', []):
        if item.get('type') != 'remote' or not item.get('url'):
            continue
        # Only read local profile files under the known directory.
        filename = item.get('file', '')
        if not filename or Path(filename).name != filename:
            continue
        old = by_url.get(source_key(item['url']), {})
        identifier = old.get('name') or 'verge_' + hashlib.sha256(str(item.get('uid', filename)).encode()).hexdigest()[:12]
        add({'name': identifier, 'display_name': item.get('name') or identifier,
             'url': item['url']}, document(root / 'profiles' / filename))
    # Keep sources that were configured directly in LinkBox / provider collections.
    for source in registry:
        provider = config.get('proxy-providers', {}).get(source.get('name'), {})
        cache = provider.get('path') or str(root / 'providers/linkbox' / (source.get('name', '') + '.yaml'))
        path = Path(cache); path = path if path.is_absolute() else root / path
        add({**source, 'display_name': source.get('display_name') or source.get('name', '')}, document(path))
    for name, provider in config.get('proxy-providers', {}).items():
        if provider.get('type') != 'http' or not provider.get('url'):
            continue
        path = Path(provider.get('path', '')); path = path if path.is_absolute() else root / path
        add({'name': name, 'display_name': name, 'url': provider['url']}, document(path))
    if len({s['name'] for s, _ in sources}) != len(sources):
        raise RuntimeError('订阅标识冲突，请先整理 Clash Verge 订阅')
    fingerprint = hashlib.sha256(json.dumps([sources, runtime.read_json('node-policy.json')], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return sources, fingerprint


def catalog():
    sources, fingerprint = discover()
    _, proxies = t.state()
    live = set(proxies.get(t.ENTRY, {}).get('all', []))
    current = proxies.get(t.ENTRY, {}).get('now', '')
    result = []
    owner = runtime.provider_for(current, '')
    current_source = next((s['name'] for s,d in sources if s['name']==owner and any(n['name']==current for n in d['proxies'])), None)
    if current_source is None:
        current_source = next((s['name'] for s,d in sources if any(n['name']==current for n in d['proxies'])), None)
    for source, doc in sources:
        name = source['name']
        nodes = [{'name': n['name'], 'type': n['type'],
                  'selected': n['name'] in live and runtime.allowed(n['name'], name),
                  'current': n['name'] == current and name == current_source} for n in doc['proxies']]
        result.append({'id': name, 'name': source['display_name'], 'nodes': nodes,
                       'warning': '' if nodes else '本地暂无可用缓存，请先在 Clash Verge 更新此订阅'})
    return {'sources': result, 'fingerprint': fingerprint, 'current': current}


def apply(request):
    sources, fingerprint = discover()
    if request.get('fingerprint') != fingerprint:
        raise RuntimeError('订阅或筛选已变化，请重新打开管理节点')
    selection = request.get('selected')
    if not isinstance(selection, dict) or set(selection) != {s['name'] for s, _ in sources}:
        raise RuntimeError('节点选择无效，请重新打开管理节点')
    prepared = {}; registry = []; chosen = {}; owners = {}
    for source, doc in sources:
        name = source['name']; values = selection[name]
        if not isinstance(values, list) or any(not isinstance(x, str) for x in values) or len(set(values)) != len(values):
            raise RuntimeError('节点选择格式无效')
        available = {n['name'] for n in doc['proxies']}
        if not set(values) <= available:
            raise RuntimeError('订阅节点已变化，请重新打开管理节点')
        for value in values:
            if value in owners:
                raise RuntimeError('不同订阅含同名节点「' + value + '」，请只选择其中一个')
            owners[value] = name
        if values:
            registry.append(source); prepared[name] = doc; chosen[name] = values
    def unchanged():
        if discover()[1] != fingerprint:
            raise RuntimeError('订阅或筛选已变化，未保存；请重新打开管理节点')
    result = update.run(prepared, selection=chosen, sources_override=registry, verify=unchanged)
    result['message'] = '已保存 ' + str(sum(map(len, chosen.values()))) + ' 个订阅节点；当前中转入口保留，未自动切换。'
    return result
