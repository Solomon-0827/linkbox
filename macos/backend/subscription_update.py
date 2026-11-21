"""Validate and apply a subscription reconciliation plan."""
import copy,datetime,fcntl,json,os,re,subprocess,tempfile,urllib.request,urllib.parse
from pathlib import Path
from time import monotonic, sleep
import yaml
import runtime
from reconcile import reconcile, same_entry_members, selection_owners
import toolbox as t
import chain_test as c

MARK='// BEGIN LINKBOX MANAGED PROVIDERS'
NOTICE=re.compile('剩余流量|重置剩余|套餐到期|官网续费|务必加Q群')
def atomic(path,data):
    path.parent.mkdir(parents=True,exist_ok=True)
    fd,tmp=tempfile.mkstemp(prefix='.linkbox-',dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as f:f.write(data)
        os.replace(tmp,path)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)
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
        return {**doc, 'proxies': [n for n in doc['proxies'] if n['name'] not in (t.ENTRY, t.EXIT, 'DIRECT', 'REJECT') and not NOTICE.search(n['name'])]}
    except Exception:raise RuntimeError('订阅下载或解析失败；未改动当前配置') from None


NO_SELECTION = '订阅里已没有你勾选的节点，请先在管理节点里勾选'
RECOVERY_HINT = '上次订阅更新未完成，可刷新重试，或在管理节点重新保存'
INVALID_CONFIG = '无法读取 Clash Verge 配置，未修改'
VALIDATION_FAILED = '配置校验失败，未改动当前代理'
EXTERNAL_CHANGE = '配置或节点已被其他操作改变，已取消更新'
POST_RELOAD_CHANGE = '更新后检测到外部链路或节点变化，请刷新并核对 Clash'
RELOAD_UNCERTAIN = '已写入新配置，Clash 尚未确认，请刷新状态核对'
RELOAD_NOT_SENT = '无法连接 Clash 控制接口，未发送重载请求'
SWITCH_FAILED = '配置已更新，但无法切换中转入口，请刷新并核对 Clash'
ENTRY_ROUTE = '/proxies/' + urllib.parse.quote(t.ENTRY, safe='')
CHAIN_KEYS = ('mode', 'tun', 'exit', 'dialer')


def read(path):
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


def name_filter(definition):
    include = [re.compile(pattern) for pattern in (definition.get('filter') or '').split('`') if pattern]
    exclude = [re.compile(pattern) for pattern in (definition.get('exclude-filter') or '').split('`') if pattern]
    return lambda name: (not include or any(p.search(name) for p in include)) and not any(
        p.search(name) for p in exclude)


def entry_seed_owners(config, sources):
    from subscription_picker import source_key

    available = {source['name']: source for source, doc in sources if doc is not None}
    by_url = {source_key(source['url']): source for source in available.values()}
    group = next((g for g in config.get('proxy-groups', []) if g['name'] == t.ENTRY), {})
    use = group.get('use') or []
    if not use:
        return {}
    try:
        response = t.api('GET', '/providers/proxies')
    except Exception:
        return {}
    providers = config.get('proxy-providers') or {}
    owners = {}
    live_providers = t.provider_nodes(response)
    for name in use:
        definition = providers.get(name)
        url = definition.get('url') if isinstance(definition, dict) else None
        if url is not None and not isinstance(url, str):
            continue
        try:
            source = by_url.get(source_key(url)) if url else available.get(name)
        except ValueError:
            continue
        for node in live_providers.get(name, []):
            owners.setdefault(node['name'], source['name'] if source else None)
    return owners


def configure_entry(groups, use):
    group = next((g for g in groups if g['name'] == t.ENTRY), None)
    if group is None:
        raise RuntimeError('缺少中转入口组')
    group['proxies'] = []
    group['use'] = use
    for key in ('url', 'include-all', 'include-all-proxies', 'include-all-providers', 'filter', 'exclude-filter', 'exclude-type'):
        group.pop(key, None)


def transform(config, managed, replacement):
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
    updated['proxies'] = [n for n in updated.get('proxies', []) if n['name'] not in replacement]
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
            '  const g=groups.find(g=>g.name==="中转入口");\n'
            '  if(g){g.proxies=[];g.use=m.use;\n'
            '    for(const k of ["url","include-all","include-all-proxies","include-all-providers","filter","exclude-filter","exclude-type"])delete g[k];}\n'
            '  r.dns=r.dns||{};\n'
            '  for(const k of ["nameserver-policy","proxy-server-nameserver-policy"])r.dns[k]={...(r.dns[k]||{}),...m.dns};\n'
            '  return r;\n'
            '};\n').encode()


def update_selector(index, name):
    profile = next((item for item in index.get('items', [])
                    if index.get('current') and item.get('uid') == index['current']), None)
    if profile is None:
        return False
    choices = profile.setdefault('selected', [])
    choice = next((item for item in choices if item.get('name') == t.ENTRY), None)
    if choice is None:
        choices.append({'name': t.ENTRY, 'now': name})
    elif choice.get('now') != name:
        choice['now'] = name
    else:
        return False
    return True


def legacy_pin(original, config, saved_name):
    if not saved_name or not original or MARK.encode() not in original:
        return []
    try:
        wrapper = original.decode().split(MARK, 1)[1]
        pin = json.JSONDecoder().raw_decode(wrapper.split('const m=', 1)[1])[0]['pin']
    except (ValueError, IndexError, KeyError, TypeError):
        return []
    if not isinstance(pin, dict) or pin.get('name') != saved_name or pin not in config.get('proxies', []):
        return []
    if (any(g['name'] != t.ENTRY and (saved_name in (g.get('proxies') or [])
            or ((g.get('include-all-proxies') or g.get('include-all')) and name_filter(g)(saved_name)))
            for g in config.get('proxy-groups', []))
            or any(n.get('dialer-proxy') == saved_name for n in config.get('proxies', []))):
        return []
    return [saved_name]


def observe_reload():
    try:
        return t.relay_state(timeout=1)
    except Exception:
        return None


def confirmed_state(observed, members):
    if observed is not None and same_entry_members(observed['live'], members):
        return observed


def wait_for_reload(members):
    deadline = monotonic() + 10
    for attempt in range(6):
        after = confirmed_state(observe_reload(), members)
        if after is not None:
            return after
        remaining = deadline - monotonic()
        if attempt == 5 or remaining <= 0:
            break
        sleep(min(2, remaining))
    raise RuntimeError(RELOAD_UNCERTAIN)


def check_chain(state):
    if state['mode'] != 'global' or state['exit'] != t.EXIT or state['dialer'] != t.ENTRY:
        raise RuntimeError('当前链路不符，未修改')


def select_after_reload(before, after, members, selected, desired):
    def acceptable(entry):
        return entry in selected and (before['entry'] in selected or entry == desired)

    def checked_state(observed, error):
        if observed is None or any(observed[k] != before[k] for k in CHAIN_KEYS):
            raise RuntimeError(error)
        return observed

    after = checked_state(after, POST_RELOAD_CHANGE)
    if acceptable(after['entry']):
        return after['entry']
    after = checked_state(confirmed_state(observe_reload(), members), SWITCH_FAILED)
    for _ in range(2):
        if acceptable(after['entry']):
            return after['entry']
        try:
            t.api('PUT', ENTRY_ROUTE, {'name': desired})
        except Exception:
            pass  # Check whether the switch applied before retrying.
        after = checked_state(confirmed_state(observe_reload(), members), SWITCH_FAILED)
        if after['entry'] == desired:
            sleep(.3)
            after = checked_state(confirmed_state(observe_reload(), members), SWITCH_FAILED)
            if after['entry'] != desired:
                raise RuntimeError(SWITCH_FAILED)
            return desired
    if acceptable(after['entry']):
        return after['entry']
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
    return bool(source) and (root / source).resolve() == (root / 'providers/linkbox' / (owner + '.yaml')).resolve()


def provider_payload(definition, root, read_cache, *, filtered):
    payload = definition.get('payload')
    if source := definition.get('path'):
        data = yaml.safe_load(read_cache(root / source) or b'')
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
        accepts = name_filter(entry)
        include_all = entry.get('include-all')
        if include_all or entry.get('include-all-proxies'):
            for name, node in static_nodes.items():
                if accepts(name):
                    members.setdefault(name, (None, node))
        providers = config.get('proxy-providers') or {}
        use = sorted(providers) if include_all or entry.get('include-all-providers') else entry.get('use') or []
        for owner in use:
            for node in provider_payload(providers[owner], root, read, filtered=True):
                if accepts(node['name']):
                    members.setdefault(node['name'], (owner, node))
        return members
    except (OSError, ValueError, TypeError, AttributeError, KeyError, StopIteration, RuntimeError, re.error, yaml.YAMLError):
        return None


def confirm_pending_owners(owners, committed):
    previous = selection_owners(committed)
    if committed is not None and not same_entry_members(previous, owners):
        return True
    changed = {name: owner for name, owner in owners.items() if previous.get(name) != owner}
    if not changed:
        return True
    # Equal names can hide a provider change. Look for the new owner before confirming it.
    try:
        providers = t.provider_nodes(t.api('GET', '/providers/proxies'))
    except Exception:
        return False
    names = {owner: {node['name'] for node in nodes} for owner, nodes in providers.items()}
    return all(name in names.get(owner, ()) and name not in names.get(previous.get(name), ())
               for name, owner in changed.items())


def reload_payload(config, root, updates, baselines):
    # The service cannot read LinkBox's user-owned provider cache files.
    live = copy.deepcopy(config)
    entry = next(g for g in live['proxy-groups'] if g['name'] == t.ENTRY)
    use = set(entry.get('use') or [])
    members = set(entry.get('proxies') or [])

    def read_cache(path):
        if path not in updates and path not in baselines:
            baselines[path] = read(path)
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


def policy_bytes(policy):
    return json.dumps(policy, ensure_ascii=False, indent=2).encode()


def finish_update(policy_file, saved, profiles, entry):
    original = profiles.read_bytes()
    index = yaml.safe_load(original)
    if update_selector(index, entry):
        if read(profiles) != original:
            raise RuntimeError(EXTERNAL_CHANGE)
        atomic(profiles, dump(index))
    atomic(policy_file, policy_bytes(saved))


def rollback(written, originals):
    for path in reversed(written):
        data = originals[path]
        if data is None:
            path.unlink(missing_ok=True)
        else:
            atomic(path, data)


def send_reload(payload):
    try:
        t.api('PUT', '/configs?force=false', {'payload': payload.decode()})
    except Exception as error:
        if t.request_not_sent(error) or (isinstance(error, t.ClashHTTPError) and error.rejected):
            raise
        return False
    return True


def run(metric='chain', *, request=None, removal=None, initialize=False):
    import subscription_picker as picker
    os.umask(0o077)
    with open(t.BASE / 'latency.lock', 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('已有测速或订阅更新正在运行') from None
        policy = runtime.read_json('node-policy.json')
        policy_file = runtime.BASE / 'node-policy.json'
        selection = picker.target_selection(policy)
        legacy = any(key in policy for key in ('pinned_entry', 'node_providers', 'verge_sync',
                                                'blocked_providers', 'excluded_nodes'))
        needs_initialization = selection is None or legacy or policy.get('initialization_pending') is True
        root = runtime.CONFIG_DIR
        pending = policy.get('pending_update')
        recovering = initialize and pending is not None
        if initialize and not (needs_initialization or recovering):
            return False
        before = t.relay_state()
        check_chain(before)
        if recovering:
            pending = pending or {}
            if pending.get('root', str(root)) != str(root):
                raise RuntimeError('Clash 配置目录已变化，请在管理节点里重新勾选')
        syncing = not recovering and request is None and removal is None
        preview_file = runtime.BASE / picker.PREVIEW
        initialization_policy = picker.fingerprint([str(root), picker.committed_policy(policy)])
        if initialize and not recovering and picker.document(read(preview_file)).get('initialization_policy') == initialization_policy:
            raise RuntimeError(NO_SELECTION)
        config_file, script, profiles = root / 'clash-verge.yaml', root / 'profiles/Script.js', root / 'profiles.yaml'
        baselines = {path: read(path) for path in (config_file, script, profiles, policy_file)}
        sources, fingerprint, preview_id = picker.discover(for_update=syncing, recovering=recovering)
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
        if syncing:
            refreshed = []
            for source, _ in sources:
                try:
                    doc = fetch(source['url'])
                except Exception:
                    if not initialize:
                        raise RuntimeError('订阅下载或解析失败，未改动当前配置') from None
                else:
                    refreshed.append((source, doc))
            if len(refreshed) != len(sources):
                raise RuntimeError('订阅下载或解析失败，未改动当前配置')
            sources = refreshed
            if t.relay_state() != before or picker.discover(for_update=True)[1] != fingerprint:
                raise RuntimeError(EXTERNAL_CHANGE)
        if syncing or (preview_id and (request is not None or recovering)):
            updates.update({root / 'profiles' / source['profile_file']: dump(doc) for source, doc in sources})
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
        if recovering:
            disk = entry_plan(config, root)
            owners = selection_owners(pending.get('selection'))
            # The journal is written first, so matching live and disk alone could confirm an older selection.
            if (owners and disk is not None and same_entry_members(before['live'], disk)
                    and owners == {name: owner for name, (owner, _) in disk.items()}
                    and confirm_pending_owners(owners, policy.get('selected_nodes'))):
                if t.relay_state() != before or any(read(p) != raw for p, raw in baselines.items()):
                    raise RuntimeError(EXTERNAL_CHANGE)
                entry = before['entry']
                if entry not in owners:
                    # Keep the ranking aware of duplicate names, even when picker caches have changed.
                    candidates = {source['id']: source['nodes'] for source in inventory}
                    for owner, names in selection.items():
                        candidates[owner] = list(dict.fromkeys([*names, *candidates.get(owner, [])]))
                    ranking = [{'id': owner, 'nodes': names} for owner, names in candidates.items()]
                    desired = reconcile(ranking, selection, [], None, metric, benchmark_results())['entry']
                    entry = select_after_reload(before, before, disk, owners, desired)
                saved = {'selected_nodes': selection, 'provider_labels': labels}
                finish_update(policy_file, saved, profiles, entry)
                return True
            if any(doc is None and (selection or {}).get(source['name']) for source, doc in sources):
                raise RuntimeError('本地缓存暂不可读，保留原勾选')
        seed_owners = entry_seed_owners(config, sources) if selection is None else None
        plan = reconcile(inventory, selection, before['live'], before['entry'], seed_owners=seed_owners)
        if not plan['candidates']:
            if syncing:
                preview_data = {'revision': fingerprint, 'documents': {s['name']: doc for s, doc in sources}}
                if needs_initialization:
                    preview_data['initialization_policy'] = initialization_policy
                atomic(preview_file, dump(preview_data))
            raise RuntimeError(NO_SELECTION)

        replacement = legacy_pin(baselines[script], config, policy.get('pinned_entry'))
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
            cache = root / 'providers/linkbox' / (owner + '.yaml')
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
        updated = transform(config, managed, replacement)
        # Keep the old pin definition until the config containing it is replaced.
        updates[config_file] = dump(updated)
        updates[script] = script_text(baselines[script], managed)
        payload, members = reload_payload(updated, root, updates, baselines)
        selected = {owner: [name for name in names if name in members]
                    for owner, names in plan['selection'].items()}
        desired = reconcile(inventory, selected, [], None, metric, benchmark_results())['entry']
        if desired is None:
            raise RuntimeError(NO_SELECTION)
        selected_names = selection_owners(selected)
        index = yaml.safe_load(baselines[profiles])
        if update_selector(index, before['entry'] if before['entry'] in selected_names else desired):
            updates[profiles] = dump(index)
        pin = policy.get('pinned_entry')
        if pin and pin not in members:
            plan['selection'] = {owner: [name for name in names if name != pin]
                                 for owner, names in plan['selection'].items()}
            plan['selection'] = {owner: names for owner, names in plan['selection'].items() if names}
        saved = {'selected_nodes': plan['selection'], 'provider_labels': labels}
        old_owners = selection_owners(policy.get('selected_nodes'))
        new_owners = selection_owners(plan['selection'])
        require_response = recovering or any(old_owners.get(name) != owner for name, owner in new_owners.items())
        updates[runtime.BASE / 'subscriptions.json'] = json.dumps({'sources': registry}, ensure_ascii=False, indent=2).encode()
        originals = {path: baselines[path] if path in baselines else read(path) for path in updates}
        originals[policy_file] = baselines[policy_file]

        try:
            with tempfile.TemporaryDirectory(prefix='linkbox-update-', dir=root) as folder:
                file = Path(folder) / 'config.yaml'
                file.write_bytes(payload)
                subprocess.run([c.CORE, '-t', '-d', str(root), '-f', str(file)],
                               capture_output=True, timeout=30, check=True)
        except (OSError, subprocess.SubprocessError):
            raise RuntimeError(VALIDATION_FAILED) from None
        if picker.discover(for_update=syncing, recovering=recovering)[1] != fingerprint:
            raise RuntimeError(EXTERNAL_CHANGE)
        if t.relay_state() != before or any(read(p) != raw for p, raw in (originals | baselines).items()):
            raise RuntimeError(EXTERNAL_CHANGE)

        changes = {path: data for path, data in updates.items() if data != originals[path]}
        backup_files = [path for path in changes if originals[path] is not None]
        if backup_files:
            backup = runtime.BASE / 'backups' / ('update-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
            backup.mkdir(parents=True)
            for i, path in enumerate(backup_files):
                (backup / (str(i) + '-' + path.name)).write_bytes(originals[path])
        written = []
        if not recovering or pending.get('selection') != plan['selection']:
            last_saved = picker.committed_policy(policy)
            journal = {'root': str(root), 'selection': plan['selection']}
            atomic(policy_file, policy_bytes({**last_saved, 'pending_update': journal}))
            written.append(policy_file)
        try:
            for path, data in changes.items():
                atomic(path, data)
                written.append(path)
        except Exception:
            rollback(written, originals)
            raise
        try:
            acknowledged = send_reload(payload)
        except Exception as error:
            unsent = t.request_not_sent(error)
            rollback(written, originals)
            message = RELOAD_NOT_SENT if unsent else 'Clash 未更新'
            raise RuntimeError(message + '，文件已回退；请刷新状态后重试') from None
        if require_response and not acknowledged:
            raise RuntimeError(RELOAD_UNCERTAIN)
        after = wait_for_reload(members)
        desired = select_after_reload(before, after, members, selected_names, desired)
        finish_update(policy_file, saved, profiles, desired)
        if initialize:
            return True
        message = '已同步 Clash Verge 订阅。' if syncing else '已保存节点选择。'
        return {'message': message}
