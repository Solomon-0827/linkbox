"""Validate and apply a subscription reconciliation plan."""
import base64
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
    if (any(g['name'] != t.ENTRY and saved_name in (g.get('proxies') or [])
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


def select_after_reload(before, after, members, selection, metric, inventory):
    owners = selection_owners(selection)

    def checked_state(observed, error):
        if observed is None or any(observed[k] != before[k] for k in CHAIN_KEYS):
            raise RuntimeError(error)
        return observed

    after = checked_state(after, POST_RELOAD_CHANGE)
    if after['entry'] in owners:
        return after['entry']
    desired = reconcile(inventory(), selection, after['live'], None, metric, benchmark_results())['entry']
    if desired is None:
        desired = next(iter(owners))
    after = checked_state(confirmed_state(observe_reload(), members), SWITCH_FAILED)
    for _ in range(2):
        if after['entry'] in owners:
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
    if after['entry'] in owners:
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


def reload_payload(config, root, selection, updates):
    # The service cannot read LinkBox's user-owned provider cache files.
    live = copy.deepcopy(config)
    use = next(g for g in live['proxy-groups'] if g['name'] == t.ENTRY)['use']
    for owner, definition in live['proxy-providers'].items():
        if not managed_cache(root, owner, definition):
            continue
        path = root / definition.pop('path')
        data = yaml.safe_load(updates[path] if path in updates else path.read_bytes())
        payload = data.get('proxies') if isinstance(data, dict) else None
        if not isinstance(payload, list):
            raise RuntimeError('代理缓存不完整，未修改')
        if owner in use:
            keep = set(selection[owner])
            payload = [node for node in payload if node['name'] in keep]
        definition.pop('url', None)
        definition.update(type='inline', payload=compact(payload))
    return dump(live)


def write_policy(path, policy):
    atomic(path, json.dumps(policy, ensure_ascii=False, indent=2).encode())


def recorded_file(path, data):
    return [str(path), base64.b64encode(data).decode() if data is not None else None]


def replay_files(files):
    for name, data in files:
        path = Path(name)
        if data is None:
            path.unlink(missing_ok=True)
        else:
            atomic(path, base64.b64decode(data))


def rollback(policy_file, policy, written, originals):
    files = [recorded_file(path, originals[path]) for path in [*reversed(written), policy_file]]
    policy['pending_update'] = {'root': policy['pending_update']['root'], 'rollback': files}
    write_policy(policy_file, policy)
    replay_files(files)


def send_reload(payload):
    try:
        t.api('PUT', '/configs?force=false', {'payload': payload.decode()})
    except Exception as error:
        if t.request_not_sent(error) or (isinstance(error, t.ClashHTTPError) and error.rejected):
            raise
        return False
    return True


def confirm_reload(policy_file, policy, members, acknowledged):
    pending = policy['pending_update']
    pending.pop('files', None)
    if acknowledged:
        pending.pop('require_response', None)
    write_policy(policy_file, policy)
    if pending.get('require_response'):
        raise RuntimeError(RELOAD_UNCERTAIN)
    return wait_for_reload(members)


def finish_update(policy_file, policy, members, before, after, profiles, metric, inventory):
    if policy.pop('reload_unconfirmed', None):
        write_policy(policy_file, policy)
    desired = select_after_reload(before, after, members, policy['selected_nodes'], metric, inventory)
    original = profiles.read_bytes()
    index = yaml.safe_load(original)
    if update_selector(index, desired):
        if read(profiles) != original:
            raise RuntimeError(EXTERNAL_CHANGE)
        atomic(profiles, dump(index))
    policy.pop('initialization_pending', None)
    policy.pop('pending_update', None)
    write_policy(policy_file, policy)


def resume_update(root, policy_file, policy, metric):
    import subscription_picker as picker
    profiles = root / 'profiles.yaml'
    selection = policy['selected_nodes']
    pending = policy.setdefault('pending_update', {})
    if pending.get('root', str(root)) != str(root):
        raise RuntimeError('请先恢复原 Clash 配置目录以完成订阅更新')
    if 'rollback' in pending:
        replay_files(pending['rollback'])
        return True
    # Older pending records can recover the planned names from the saved selection.
    members = pending.setdefault('members', list(selection_owners(selection)))
    before = observe_reload()
    if before is None:
        raise RuntimeError(t.RELOAD_PENDING)
    check_chain(before)
    after = confirmed_state(before, members)
    if 'files' in pending or pending.get('require_response') or after is None:
        if 'files' in pending:
            replay_files(pending['files'])
        config = yaml.safe_load((root / 'clash-verge.yaml').read_bytes())
        exit_node = next((n for n in config.get('proxies', []) if n['name'] == t.EXIT), {})
        if exit_node.get('dialer-proxy') != t.ENTRY:
            raise RuntimeError('固定出口的链式上游已变化，未修改')
        use = [owner for owner, names in selection.items() if names]
        if not set(use) <= config.get('proxy-providers', {}).keys():
            raise RuntimeError('代理缓存不完整，未修改')
        configure_entry(config.get('proxy-groups', []), use)
        payload = reload_payload(config, root, selection, {})
        if not policy.get('reload_unconfirmed'):
            policy['reload_unconfirmed'] = True
            write_policy(policy_file, policy)
        try:
            acknowledged = send_reload(payload)
        except Exception as error:
            message = RELOAD_NOT_SENT if t.request_not_sent(error) else 'Clash 拒绝重载配置'
            raise RuntimeError(message + '；请刷新状态后重试') from None
        after = confirm_reload(policy_file, policy, members, acknowledged)
    finish_update(policy_file, policy, members, before, after, profiles, metric,
                  lambda: picker.inventory(picker.discover()[0]))
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
        selection = policy.get('selected_nodes')
        legacy = any(key in policy for key in ('pinned_entry', 'node_providers', 'verge_sync',
                                                'blocked_providers', 'excluded_nodes'))
        needs_initialization = selection is None or legacy or policy.get('initialization_pending') is True
        root = runtime.CONFIG_DIR
        if initialize and (policy.get('pending_update') or policy.get('reload_unconfirmed')):
            return resume_update(root, policy_file, policy, metric)
        if policy.get('reload_unconfirmed'):
            raise RuntimeError(t.RELOAD_PENDING)
        if initialize and not needs_initialization:
            return False
        before = t.relay_state()
        check_chain(before)
        syncing = request is None and removal is None
        preview_file = runtime.BASE / picker.PREVIEW
        initialization_policy = picker.fingerprint([str(root), policy])
        if initialize and picker.document(read(preview_file)).get('initialization_policy') == initialization_policy:
            raise RuntimeError(NO_SELECTION)
        config_file, script, profiles = root / 'clash-verge.yaml', root / 'profiles/Script.js', root / 'profiles.yaml'
        baselines = {path: read(path) for path in (config_file, script, profiles, policy_file)}
        sources, fingerprint, preview = picker.discover(for_update=syncing)
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
        if syncing or (request is not None and preview):
            updates.update({root / 'profiles' / source['profile_file']: dump(doc) for source, doc in sources})
        inventory = picker.inventory(sources)
        plan = reconcile(inventory, selection, before['live'], before['entry'],
                         metric, benchmark_results())
        if not plan['candidates']:
            if syncing:
                preview_data = {'revision': fingerprint, 'documents': {s['name']: doc for s, doc in sources}}
                if needs_initialization:
                    preview_data['initialization_policy'] = initialization_policy
                atomic(preview_file, dump(preview_data))
            raise RuntimeError(NO_SELECTION)

        config = yaml.safe_load(baselines[config_file])
        exit_node = next((n for n in config.get('proxies', []) if n['name'] == t.EXIT), {})
        if exit_node.get('dialer-proxy') != t.ENTRY:
            raise RuntimeError('固定出口的链式上游已变化，未修改')
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
                    raise RuntimeError('本地缓存暂不可读，保留原勾选')
                continue
            if not keep:
                continue
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,60}', owner):
                raise RuntimeError('订阅标识需使用字母、数字或短横线')
            cache = root / 'providers/linkbox' / (owner + '.yaml')
            updates[cache] = dump(doc)
            pattern = '|'.join('^' + re.sub(r'([.\x2a+?^${}()|\[\]\\])', r'\\\1', name) + '$' for name in keep)
            definitions[owner] = {'type': 'http', 'url': source['url'], 'path': str(cache), 'interval': 86400,
                                  'health-check': {'enable': False}, 'filter': pattern}
            dns.update({k: v for k, v in ((doc.get('dns') or {}).get('nameserver-policy') or {}).items()
                        if not k.startswith(('geosite:', 'rule-set:'))})
        use = [owner for owner in definitions if plan['selection'].get(owner)]
        retired = {name: definition for name, definition in existing.items()
                   if name not in definitions and managed_cache(root, name, definition)}
        managed = {'providers': definitions, 'retired': retired, 'dns': dns, 'use': use}
        updated = transform(config, managed, replacement)
        updates[script] = script_text(baselines[script], managed)
        updates[config_file] = dump(updated)
        index = yaml.safe_load(baselines[profiles])
        if update_selector(index, plan['entry']):
            updates[profiles] = dump(index)
        registry = [s for s, _ in sources]
        saved = {'selected_nodes': plan['selection'],
                 'provider_labels': {s['name']: s['display_name'] for s in registry}}
        if needs_initialization:
            saved['initialization_pending'] = True
        members = [candidate['name'] for candidate in plan['candidates']]
        old_owners = selection_owners(policy.get('selected_nodes'))
        new_owners = selection_owners(plan['selection'])
        owner_changed = any(name in old_owners and old_owners[name] != owner for name, owner in new_owners.items())
        pending = {'members': members, 'root': str(root)}
        if owner_changed and same_entry_members(before['live'], members):
            pending['require_response'] = True
        saved['pending_update'] = pending
        saved['reload_unconfirmed'] = True
        updates[runtime.BASE / 'subscriptions.json'] = json.dumps({'sources': registry}, ensure_ascii=False, indent=2).encode()
        originals = {path: baselines[path] if path in baselines else read(path) for path in updates}
        originals[policy_file] = baselines[policy_file]

        payload = reload_payload(updated, root, plan['selection'], updates)
        try:
            with tempfile.TemporaryDirectory(prefix='linkbox-update-', dir=root) as folder:
                file = Path(folder) / 'config.yaml'
                file.write_bytes(payload)
                subprocess.run([c.CORE, '-t', '-d', str(root), '-f', str(file)],
                               capture_output=True, timeout=30, check=True)
        except (OSError, subprocess.SubprocessError):
            raise RuntimeError('配置校验失败，未改动当前代理') from None
        if (picker.discover(for_update=syncing)[1] != fingerprint or t.relay_state() != before
                or any(read(p) != raw for p, raw in (originals | baselines).items())):
            raise RuntimeError(EXTERNAL_CHANGE)

        backup = runtime.BASE / 'backups' / ('update-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
        backup.mkdir(parents=True)
        for i, (path, raw) in enumerate(originals.items()):
            if raw is not None and path != policy_file:
                (backup / (str(i) + '-' + path.name)).write_bytes(raw)
        # Keep the complete plan until every write and the first reload attempt are recorded.
        pending['files'] = [recorded_file(path, data) for path, data in updates.items()]
        write_policy(policy_file, saved)
        written = []
        try:
            for path, data in updates.items():
                atomic(path, data)
                written.append(path)
        except Exception:
            rollback(policy_file, saved, written, originals)
            raise
        try:
            acknowledged = send_reload(payload)
        except Exception as error:
            rollback(policy_file, saved, written, originals)
            message = RELOAD_NOT_SENT if t.request_not_sent(error) else 'Clash 未更新'
            raise RuntimeError(message + '，文件已回退；请刷新状态后重试') from None
        after = confirm_reload(policy_file, saved, members, acknowledged)
        finish_update(policy_file, saved, members, before, after, profiles, metric, lambda: inventory)
        if initialize:
            return True
        message = '已同步 Clash Verge 订阅。' if syncing else '已保存节点选择。'
        return {'message': message}
