"""Validate and apply a subscription reconciliation plan."""
import copy,datetime,json,os,re,urllib.request
import yaml
import runtime
from reconcile import reconcile, selection_owners
import toolbox as t
import clash

MARK='// BEGIN LINKBOX MANAGED PROVIDERS'
NOTICE=re.compile('剩余流量|重置剩余|套餐到期|官网续费|务必加Q群')
def dump(value):return yaml.safe_dump(value,allow_unicode=True,sort_keys=False).encode()
def compact(value):
    if isinstance(value,dict):return {k:compact(v) for k,v in value.items() if v is not None}
    if isinstance(value,list):return [compact(v) for v in value]
    return value
def fetch(url):
    if not isinstance(url,str) or not url.startswith('https://'):raise RuntimeError('订阅必须使用 HTTPS')
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({'https':'http://127.0.0.1:7897'}),urllib.request.HTTPSHandler(context=runtime.ssl_context()))
    try:
        with opener.open(urllib.request.Request(url,headers={'User-Agent':'clash.meta'}),timeout=45) as r:raw=r.read(8*1024*1024+1)
        if len(raw)>8*1024*1024:raise ValueError()
        doc=yaml.safe_load(raw)
        if not isinstance(doc,dict) or not isinstance(doc.get('proxies'),list):raise ValueError()
        names=set()
        for n in doc['proxies']:
            if not isinstance(n,dict) or not all(n.get(k) for k in ['name','type','server','port']) or n['name'] in names:raise ValueError()
            names.add(n['name'])
        return doc
    except Exception:raise RuntimeError('订阅下载或解析失败；未改动当前配置') from None


NO_SELECTION = '订阅里已没有你勾选的节点，请先在管理节点里勾选'
INVALID_CONFIG = '无法读取 Clash Verge 配置，未修改'
EXTERNAL_CHANGE = '配置或节点已被其他操作改变，已取消更新'
POST_RELOAD_CHANGE = '更新后检测到外部链路或节点变化，请刷新并核对 Clash'
SWITCH_FAILED = '配置已更新，但无法切换中转入口，请刷新并核对 Clash'
CHAIN_KEYS = ('mode', 'tun', 'exit', 'dialer')


def name_filter(definition):
    include = [re.compile(pattern) for pattern in (definition.get('filter') or '').split('`') if pattern]
    exclude = [re.compile(pattern) for pattern in (definition.get('exclude-filter') or '').split('`') if pattern]
    return lambda name: (not include or any(p.search(name) for p in include)) and not any(
        p.search(name) for p in exclude)


def group_filter(group):
    try:
        return name_filter(group)
    except re.error:
        # Mihomo accepts expressions that Python cannot compile.
        return lambda name: True


def entry_seed_owners(config, sources):
    from subscription_picker import source_key

    available = {source['name']: source for source, doc in sources if doc is not None}
    by_url = {source_key(source['url']): source for source in available.values()}
    group = next((g for g in config.get('proxy-groups', []) if g['name'] == t.ENTRY), {})
    use = group.get('use') or []
    if not use:
        return {}
    try:
        response = clash.providers()
    except Exception:
        return {}
    providers = config.get('proxy-providers') or {}
    owners = {}
    live_providers = t.provider_nodes(response)
    for name in use:
        definition = providers.get(name)
        url = definition.get('url') if isinstance(definition, dict) else None
        try:
            if url in (None, ''):
                source = available.get(name)
            else:
                source = by_url.get(source_key(url)) if isinstance(url, str) else None
        except ValueError:
            source = None
        # An unmappable first provider still reserves the name for picker fallback.
        for node in live_providers.get(name, []):
            owners.setdefault(node['name'], source['name'] if source else None)
    return {name: owner for name, owner in owners.items() if owner is not None}


def configure_entry(groups, use):
    group = next((g for g in groups if g['name'] == t.ENTRY), None)
    if group is None:
        raise RuntimeError('缺少中转入口组')
    group['proxies'] = []
    group['use'] = use
    for key in ('url', 'include-all', 'include-all-proxies', 'include-all-providers', 'filter', 'exclude-filter', 'exclude-type'):
        group.pop(key, None)


def transform(config, managed):
    updated = copy.deepcopy(config)
    groups = updated.get('proxy-groups', [])
    providers = updated.setdefault('proxy-providers', {})
    for name, definition in managed['retired'].items():
        if any(g['name'] != t.ENTRY and (name in (g.get('use') or []) or
               g.get('include-all') or g.get('include-all-providers')) for g in groups):
            providers[name] = definition
        else:
            providers.pop(name, None)
    providers.update(managed['providers'])
    configure_entry(groups, managed['use'])
    for key in ('nameserver-policy', 'proxy-server-nameserver-policy'):
        updated.setdefault('dns', {}).setdefault(key, {}).update(managed['dns'])
    return updated


def script_text(original, managed):
    base = original.decode() if original else 'function main(config) { return config; }'
    return (base.split(MARK)[0].rstrip() + '\n' + MARK + '\n'
            'const linkboxPreviousMain=main;\n'
            'main=function(config,profileName){\n'
            '  const r=linkboxPreviousMain(config,profileName);\n'
            f'  const m={json.dumps(managed, ensure_ascii=False)};\n'
            '  const providers=r["proxy-providers"]||{};\n'
            '  const groups=r["proxy-groups"]||[];\n'
            '  for(const [name,definition] of Object.entries(m.retired)){\n'
            '    if(groups.some(g=>g.name!=="中转入口"&&(g.use?.includes(name)||g["include-all"]||g["include-all-providers"])))providers[name]=definition;\n'
            '    else delete providers[name];}\n'
            '  r["proxy-providers"]={...providers,...m.providers};\n'
            '  if(m.pin)r.proxies=[...(r.proxies||[]).filter(p=>p.name!==m.pin.name),m.pin];\n'
            '  const g=groups.find(g=>g.name==="中转入口");\n'
            '  if(g){g.proxies=[];g.use=m.use;\n'
            '    for(const k of ["url","include-all","include-all-proxies","include-all-providers","filter","exclude-filter","exclude-type"])delete g[k];}\n'
            '  r.dns=r.dns||{};\n'
            '  for(const k of ["nameserver-policy","proxy-server-nameserver-policy"])r.dns[k]={...(r.dns[k]||{}),...m.dns};\n'
            '  return r;\n'
            '};\n').encode()


def legacy_pin(original, config, saved_name):
    if not original or MARK.encode() not in original:
        return None
    try:
        wrapper = original.decode().split(MARK, 1)[1]
        pin = json.JSONDecoder().raw_decode(wrapper.split('const m=', 1)[1])[0]['pin']
    except (ValueError, IndexError, KeyError, TypeError):
        return None
    if (not isinstance(pin, dict) or not pin.get('name') or (saved_name and pin['name'] != saved_name)
            or pin not in config.get('proxies', [])):
        return None
    return pin


def check_chain(state):
    if state['mode'] != 'global' or state['exit'] != t.EXIT or state['dialer'] != t.ENTRY:
        raise RuntimeError('当前链路不符，未修改')


def select_after_reload(before, selected, desired):
    def observe():
        try:
            state = t.relay_state()
        except Exception:
            return None
        if any(state[key] != before[key] for key in CHAIN_KEYS):
            raise RuntimeError(POST_RELOAD_CHANGE)
        return state

    after = observe()
    if (after and after['entry'] in selected and after['entry'] in after['live']
            and (before['entry'] in selected or after['entry'] == desired)):
        if before['entry'] in selected and after['entry'] != before['entry']:
            raise RuntimeError(POST_RELOAD_CHANGE)
        return after['entry']
    for _ in range(2):
        if after is None:
            after = observe()
        if after and desired in after['live']:
            if after['entry'] == desired:
                return desired
            try:
                clash.switch_entry(desired)
            except Exception:
                pass  # The switch may have applied before the response was lost.
        after = observe()
        if after and after['entry'] == desired and desired in after['live']:
            return desired
    raise RuntimeError(SWITCH_FAILED)


def benchmark_results():
    chain = runtime.read_json('chain-results.json')
    entrance = runtime.read_json('latency-results.json')
    latest = runtime.read_json('latest-benchmark.json')
    recent = chain
    if 'kind' in latest:
        recent = {'chain': chain, 'latency': entrance}.get(latest['kind'], {})
    elif entrance.get('finished_at'):
        try:
            if not chain.get('finished_at') or datetime.datetime.fromisoformat(
                    entrance['finished_at']) > datetime.datetime.fromisoformat(chain['finished_at']):
                recent = entrance
        except (TypeError, ValueError):
            pass
    if recent.get('reason') or recent.get('selection_unchanged') is False:
        return {}
    return {name: {'chain': row.get('chain_delay'), 'entrance': row.get('delay'), 'owner': row.get('owner')}
            for name, row in recent.get('results', {}).items()
            if recent is not chain or (type(row.get('chain_delay')) in (int, float) and row['chain_delay'] > 0)}


def managed_cache(root, owner, definition):
    source = definition.get('path')
    return bool(source) and clash.provider_file(root, source).resolve() == clash.managed_cache_file(root, owner).resolve()


def provider_payload(definition, root, read_cache, *, filtered):
    payload = definition.get('payload')
    if source := definition.get('path'):
        data = yaml.safe_load(read_cache(clash.provider_file(root, source)) or b'')
        payload = data.get('proxies') if isinstance(data, dict) else None
    if not isinstance(payload, list):
        raise RuntimeError('代理缓存不完整，未修改')
    if filtered:
        accepts = name_filter(definition)
        payload = [node for node in payload if accepts(node['name'])]
    return payload


def entry_plan(config, root):
    try:
        entry = next(g for g in config.get('proxy-groups', []) if g['name'] == t.ENTRY)
        static_nodes = {node['name']: node for node in config.get('proxies', [])}
        members = {name: (None, static_nodes.get(name)) for name in entry.get('proxies') or []}
        accepts = group_filter(entry)
        include_all = entry.get('include-all')
        if include_all or entry.get('include-all-proxies'):
            for name, node in static_nodes.items():
                if accepts(name):
                    members.setdefault(name, (None, node))
        providers = config.get('proxy-providers') or {}
        use = sorted(providers) if include_all or entry.get('include-all-providers') else entry.get('use') or []
        for owner in use:
            try:
                payload = provider_payload(providers[owner], root, clash.read_file, filtered=True)
            except (OSError, ValueError, TypeError, AttributeError, KeyError, RuntimeError, re.error, yaml.YAMLError):
                continue
            for node in payload:
                if accepts(node['name']):
                    members.setdefault(node['name'], (owner, node))
        return members
    except (OSError, ValueError, TypeError, AttributeError, KeyError, StopIteration, RuntimeError, re.error, yaml.YAMLError):
        return None


def reload_payload(config, root, updates, baselines):
    # The service cannot read LinkBox's user-owned provider cache files.
    live = copy.deepcopy(config)
    entry = next(g for g in live['proxy-groups'] if g['name'] == t.ENTRY)
    use = set(entry.get('use') or [])
    members = set(entry.get('proxies') or [])

    def read_cache(path):
        if path not in updates and path not in baselines:
            baselines[path] = clash.read_file(path)
        return updates.get(path, baselines.get(path))

    for owner, definition in live['proxy-providers'].items():
        managed = managed_cache(root, owner, definition)
        if not managed and owner not in use:
            continue
        payload = provider_payload(definition, root, read_cache, filtered=owner in use)
        if owner in use:
            members.update(node['name'] for node in payload)
        if managed:
            definition.pop('url', None)
            definition.pop('path', None)
            definition.update(type='inline', payload=compact(payload))
    return dump(live), members


def run(metric='chain', *, request=None, removal=None, initialize=False):
    import subscription_picker as picker
    os.umask(0o077)
    with t.switch_lock():
        policy = runtime.read_json('node-policy.json')
        policy_file = runtime.BASE / 'node-policy.json'
        selection = policy.get('selected_nodes')
        if initialize and selection is not None:
            return False
        before = t.relay_state()
        check_chain(before)
        root = clash.CONFIG_DIR
        syncing = request is None and removal is None
        preview_file = runtime.BASE / picker.PREVIEW
        config_file, script, profiles = clash.config_file(root), clash.script_file(root), clash.profiles_file(root)
        baselines = {path: clash.read_file(path) for path in (config_file, script, profiles, policy_file)}
        sources, fingerprint, preview_profiles = picker.discover(for_update=syncing)
        if request is not None:
            selection = picker.validate_selection(sources, fingerprint, request, selection)
            if request['current'] != before['entry']:
                raise RuntimeError(EXTERNAL_CHANGE)
        if removal is not None:
            names = removal.get('names')
            if (not isinstance(names, list) or not names or any(not isinstance(n, str) for n in names)
                    or removal.get('entry') != before['entry'] or before['entry'] in names
                    or not set(names) <= selection_owners(selection).keys()):
                raise RuntimeError('节点已变化；当前节点不能移除')
            if any(set(names).intersection(selection.get(source['name'], []))
                   for source, doc in sources if doc is None):
                raise RuntimeError('本地缓存暂不可读，保留原勾选')
            selection = {owner: [n for n in items if n not in names] for owner, items in selection.items()}
        updates = {}
        downloaded_profiles = preview_profiles if request is not None else None
        if syncing:
            refreshed = []
            downloaded_profiles = {}
            for source, _ in sources:
                try:
                    doc = fetch(source['url'])
                    cleaned = picker.clean(doc)
                    if cleaned is None:
                        raise ValueError()
                except Exception:
                    continue
                else:
                    refreshed.append((source, cleaned))
                    downloaded_profiles[source['name']] = doc
            if len(refreshed) != len(sources):
                raise RuntimeError('订阅下载或解析失败，未改动当前配置')
            sources = refreshed
            if t.relay_state() != before or picker.discover(for_update=True)[1] != fingerprint:
                raise RuntimeError(EXTERNAL_CHANGE)
        if downloaded_profiles:
            updates.update({clash.profile_file(root, source['profile_file']): dump(downloaded_profiles[source['name']])
                            for source, _ in sources if source['name'] in downloaded_profiles})
        try:
            config = yaml.safe_load(baselines[config_file] or b'')
        except yaml.YAMLError:
            raise RuntimeError(INVALID_CONFIG) from None
        if not isinstance(config, dict) or not isinstance(config.get('proxies'), list):
            raise RuntimeError(INVALID_CONFIG)
        exit_node = next((n for n in config.get('proxies', []) if n['name'] == t.EXIT), {})
        if exit_node.get('dialer-proxy') != t.ENTRY:
            raise RuntimeError('固定出口的链式上游已变化，未修改')
        inventory = picker.inventory(sources)
        registry = [s for s, _ in sources]
        labels = {s['name']: s['display_name'] for s in registry}
        seed_owners = entry_seed_owners(config, sources) if selection is None else None
        plan = reconcile(inventory, selection, before['live'], before['entry'], seed_owners=seed_owners)
        if not plan['candidates']:
            if syncing:
                preview_data = {'revision': fingerprint, 'profiles': downloaded_profiles}
                clash.write_file(preview_file, dump(preview_data))
            raise RuntimeError(NO_SELECTION)

        pin = legacy_pin(baselines[script], config, policy.get('pinned_entry'))
        definitions, dns = {}, {}
        existing = config.get('proxy-providers', {})
        for source, doc in sources:
            owner = source['name']
            keep = plan['selection'].get(owner)
            if doc is None:
                if owner in existing:
                    definitions[owner] = existing[owner]
                elif keep:
                    raise RuntimeError('本地缓存暂不可读，保留原勾选，请在管理节点里重新勾选')
                continue
            if not keep:
                continue
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,60}', owner):
                raise RuntimeError('订阅标识需使用字母、数字或短横线')
            cache = clash.managed_cache_file(root, owner)
            updates[cache] = dump(doc)
            # Mihomo separates filter expressions at literal backticks.
            escaped = [re.sub(r'([.*+?^${}()|\[\]\\])', r'\\\1', name).replace('`', r'\x60') for name in keep]
            pattern = '|'.join(f'^{name}$' for name in escaped)
            definitions[owner] = {'type': 'http', 'url': source['url'], 'path': str(cache), 'interval': 86400,
                                  'health-check': {'enable': False}, 'filter': pattern}
            dns.update({k: v for k, v in ((doc.get('dns') or {}).get('nameserver-policy') or {}).items()
                        if not k.startswith(('geosite:', 'rule-set:'))})
        use = [owner for owner in definitions if plan['selection'].get(owner)]
        retired = {name: definition for name, definition in existing.items()
                   if name not in definitions and managed_cache(root, name, definition)}
        managed = {'providers': definitions, 'retired': retired, 'dns': dns, 'use': use}
        if pin:
            managed['pin'] = pin
        updated = transform(config, managed)
        updates[config_file] = dump(updated)
        updates[script] = script_text(baselines[script], managed)
        payload, members = reload_payload(updated, root, updates, baselines)
        # A saved relay can be absent from the live group while its subscription cache is unreadable.
        selected = {owner: [name for name in names if name in members]
                    for owner, names in plan['selection'].items()}
        desired = reconcile(inventory, selected, [], None, metric, benchmark_results())['entry']
        if desired is None:
            raise RuntimeError(NO_SELECTION)
        selected_names = selection_owners(selected)
        planned_entry = before['entry'] if before['entry'] in selected_names else desired
        index = yaml.safe_load(baselines[profiles])
        if clash.update_selector(index, planned_entry):
            updates[profiles] = dump(index)
        saved = {'selected_nodes': plan['selection'], 'provider_labels': labels}
        updates[runtime.BASE / 'subscriptions.json'] = json.dumps({'sources': registry}, ensure_ascii=False, indent=2).encode()
        updates[policy_file] = json.dumps(saved, ensure_ascii=False, indent=2).encode()
        originals = {path: baselines[path] if path in baselines else clash.read_file(path) for path in updates}

        written = []

        def rollback():
            clash.restore_files(written, originals)

        def prepare():
            if picker.discover(for_update=syncing)[1] != fingerprint:
                raise RuntimeError(EXTERNAL_CHANGE)
            if t.relay_state() != before or any(clash.read_file(p) != raw for p, raw in (originals | baselines).items()):
                raise RuntimeError(EXTERNAL_CHANGE)

            changes = {path: data for path, data in updates.items() if data != originals[path]}
            # Keep obsolete policy data only in memory for rollback during this update.
            backup_files = [path for path in changes if originals[path] is not None
                            and (path != policy_file or policy.keys() <= saved.keys())]
            if backup_files:
                backup = runtime.BASE / 'backups' / ('update-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
                backup.mkdir(parents=True)
                for i, path in enumerate(backup_files):
                    (backup / (str(i) + '-' + path.name)).write_bytes(originals[path])
            try:
                for path, data in changes.items():
                    clash.write_file(path, data)
                    written.append(path)
            except Exception:
                rollback()
                raise

        clash.reload(root, payload, prepare, rollback)
        entry = select_after_reload(before, selected_names, desired)
        if entry != planned_entry:
            clash.persist_selection(profiles, entry)
        if initialize:
            return True
        message = '已同步 Clash Verge 订阅。' if syncing else '已保存节点选择。'
        return {'message': message}
