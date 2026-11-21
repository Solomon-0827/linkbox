"""Validate and apply a subscription reconciliation plan."""
import copy,datetime,fcntl,json,os,re,subprocess,tempfile,urllib.request,urllib.parse,uuid
from pathlib import Path
import yaml
import runtime
from reconcile import selection_owners
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
SWITCH_FAILED = '配置已更新，但无法切换中转入口，请刷新并核对 Clash'
ENTRY_ROUTE = '/proxies/' + urllib.parse.quote(t.ENTRY, safe='')


def read(path):
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


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
    group = next((g for g in groups if g['name'] == t.ENTRY), None)
    if group is None:
        raise RuntimeError('缺少中转入口组')
    group['proxies'] = []
    group['use'] = managed['use']
    for key in ('include-all', 'include-all-proxies', 'include-all-providers', 'filter', 'exclude-filter', 'exclude-type'):
        group.pop(key, None)
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
            '    for(const k of ["include-all","include-all-proxies","include-all-providers","filter","exclude-filter","exclude-type"])delete g[k];}\n'
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
    for _ in range(2):
        try:
            return t.relay_state(), t.proxy_providers()
        except Exception:
            pass
    return None


def select_after_reload(before, desired, desired_owner, use, selected_docs, revision, observation):
    names = [n['name'] for provider in use for n in selected_docs[provider]]

    def checked_state(observed, error):
        if observed is None:
            raise RuntimeError(error)
        after, providers = observed
        if (after['live'] != names or any(after[k] != before[k] for k in ('mode', 'tun', 'exit', 'dialer'))
                or providers.get(desired_owner, {}).get('testUrl') != revision
                or not t.entry_member_owned(after['live'], providers, use, desired, desired_owner)
                or any([n['name'] for n in providers.get(key, {}).get('proxies', [])]
                       != [n['name'] for n in selected_docs[key]] for key in use)):
            raise RuntimeError(error)
        return after

    after = checked_state(observation, POST_RELOAD_CHANGE)
    for _ in range(2):
        if after['entry'] == desired:
            return
        try:
            t.api('PUT', ENTRY_ROUTE, {'name': desired})
        except Exception:
            pass  # Check whether the switch applied before retrying.
        after = checked_state(observe_reload(), SWITCH_FAILED)
    if after['entry'] != desired:
        raise RuntimeError(SWITCH_FAILED)


def benchmark_results():
    chain = runtime.read_json('chain-results.json')
    entrance = runtime.read_json('latency-results.json')
    recent = chain
    if entrance.get('finished_at'):
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


def run(metric='chain', *, request=None, removal=None, initialize=False):
    import subscription_picker as picker
    os.umask(0o077)
    with open(t.BASE / 'latency.lock', 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('已有测速或订阅更新正在运行') from None
        policy = runtime.read_json('node-policy.json')
        selection = policy.get('selected_nodes')
        legacy = any(key in policy for key in ('pinned_entry', 'node_providers', 'verge_sync',
                                                'blocked_providers', 'excluded_nodes'))
        needs_initialization = selection is None or legacy or policy.get('initialization_pending') is True
        if initialize and not needs_initialization:
            return False
        before = t.relay_state()
        if before['mode'] != 'global' or before['exit'] != t.EXIT or before['dialer'] != t.ENTRY:
            raise RuntimeError('当前链路不符，未修改')
        syncing = request is None and removal is None
        root = runtime.CONFIG_DIR
        preview_file = runtime.BASE / picker.PREVIEW
        initialization_policy = picker.fingerprint([str(root), policy])
        if initialize and picker.document(read(preview_file)).get('initialization_policy') == initialization_policy:
            raise RuntimeError(NO_SELECTION)
        config_file, script, profiles = root / 'clash-verge.yaml', root / 'profiles/Script.js', root / 'profiles.yaml'
        policy_file = runtime.BASE / 'node-policy.json'
        baselines = {path: read(path) for path in (config_file, script, profiles, policy_file)}
        sources, fingerprint, preview = picker.discover(for_update=syncing)
        if request is not None:
            selection = picker.validate_selection(sources, fingerprint, request)
            if request['current'] != before['entry']:
                raise RuntimeError(EXTERNAL_CHANGE)
        if removal is not None:
            names = removal.get('names')
            if (not isinstance(names, list) or not names or any(not isinstance(n, str) for n in names)
                    or removal.get('entry') != before['entry'] or before['entry'] in names
                    or not set(names) <= selection_owners(selection).keys()):
                raise RuntimeError('节点已变化；当前节点不能移除')
            selection = {owner: [n for n in items if n not in names] for owner, items in selection.items()}
        updates = {}
        if syncing:
            refreshed = []
            for source, _ in sources:
                try:
                    doc = fetch(source['url'])
                except Exception:
                    if not initialize:
                        raise
                else:
                    refreshed.append((source, doc))
            if len(refreshed) != len(sources):
                raise RuntimeError('订阅下载或解析失败，未改动当前配置')
            sources = refreshed
            if t.relay_state() != before or picker.discover(for_update=True)[1] != fingerprint:
                raise RuntimeError(EXTERNAL_CHANGE)
        if syncing or (request is not None and preview):
            updates.update({root / 'profiles' / source['profile_file']: dump(doc) for source, doc in sources})
        plan = picker.plan(sources, selection, before, metric, benchmark_results())
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
        desired = plan['entry']
        desired_owner = selection_owners(plan['selection'])[desired]
        definitions, dns, selected_docs = {}, {}, {}
        for source, doc in sources:
            owner = source['name']
            keep = plan['selection'].get(owner)
            if not keep:
                continue
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,60}', owner):
                raise RuntimeError('订阅标识需使用字母、数字或短横线')
            cache = root / 'providers/linkbox' / (owner + '.yaml')
            nodes = doc['proxies']
            updates[cache] = dump(doc)
            pattern = '|'.join('^' + re.sub(r'([.\x2a+?^${}()|\[\]\\])', r'\\\1', name) + '$' for name in keep)
            definitions[owner] = {'type': 'http', 'url': source['url'], 'path': str(cache), 'interval': 86400,
                                  'health-check': {'enable': False}, 'filter': pattern}
            selected_docs[owner] = [n for n in nodes if n['name'] in keep]
            dns.update({k: v for k, v in ((doc.get('dns') or {}).get('nameserver-policy') or {}).items()
                        if not k.startswith(('geosite:', 'rule-set:'))})
        use = list(definitions)
        retired = {name: definition for name, definition in config.get('proxy-providers', {}).items()
                   if name not in definitions and definition.get('path')
                   and (root / definition['path']).resolve() == (root / 'providers/linkbox' / (name + '.yaml')).resolve()}
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
        completed_policy = json.dumps(saved, ensure_ascii=False, indent=2).encode()
        if needs_initialization:
            saved['initialization_pending'] = True
        updates[policy_file] = json.dumps(saved, ensure_ascii=False, indent=2).encode()
        updates[runtime.BASE / 'subscriptions.json'] = json.dumps({'sources': registry}, ensure_ascii=False, indent=2).encode()
        originals = {path: baselines[path] if path in baselines else read(path) for path in updates}

        # The service reload uses inline snapshots because it cannot read user-owned paths.
        live = copy.deepcopy(updated)
        for name, definition in live['proxy-providers'].items():
            source_path = definition.get('path')
            if not source_path:
                continue
            payload = selected_docs.get(name)
            if payload is None:
                data = yaml.safe_load((root / source_path).read_bytes())
                payload = data.get('proxies')
                if not isinstance(payload, list):
                    raise RuntimeError('代理缓存不完整，未修改')
            definition.pop('path')
            definition.pop('url', None)
            definition.update(type='inline', payload=compact(payload))
        # A disabled health check exposes a revision in the API without changing relay names or making requests.
        revision = 'https://www.gstatic.com/generate_204#linkbox-' + uuid.uuid4().hex
        live['proxy-providers'][desired_owner]['health-check']['url'] = revision
        payload = dump(live)
        request_body = {'payload': payload.decode()}
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
        written = []
        try:
            for path, data in updates.items():
                atomic(path, data)
                written.append(path)
        except Exception:
            rollback(written, originals)
            raise
        try:
            t.api('PUT', '/configs?force=false', request_body)
        except Exception as error:
            if isinstance(error, t.ClashHTTPError) and error.rejected:
                rollback(written, originals)
                raise RuntimeError('Clash 未更新，文件已回退；请刷新状态后重试') from None
            # The first request may still apply, even if the retry is rejected.
            try:
                t.api('PUT', '/configs?force=false', request_body)
            except Exception:
                pass
        observed = observe_reload()
        if observed is None or observed[1].get(desired_owner, {}).get('testUrl') != revision:
            raise RuntimeError(RELOAD_UNCERTAIN)
        select_after_reload(before, desired, desired_owner, use, selected_docs, revision, observed)
        if needs_initialization:
            atomic(policy_file, completed_policy)
        if initialize:
            return True
        message = '已同步 Clash Verge 订阅。' if syncing else '已保存节点选择。'
        return {'message': message}


def rollback(written, originals):
    for path in reversed(written):
        if originals[path] is None:
            path.unlink(missing_ok=True)
        else:
            atomic(path, originals[path])
