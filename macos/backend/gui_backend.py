#!/usr/bin/env python3
import json
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
import subprocess
import sys
import urllib.request
import datetime
import fcntl
import os
import benchmark_policy as policy
import clash
import toolbox as t
import runtime
from settings import SettingsError, benchmark_settings

def node_rows(p, owners):
    inventory = t.node_inventory(p, owners)
    records = [runtime.read_json(file) for file in ('latency-results.json', 'chain-results.json')]

    def finished_at(record):
        try:
            return datetime.datetime.fromisoformat(record.get('finished_at', '')).timestamp()
        except (TypeError, ValueError):
            return 0

    records.sort(key=finished_at)
    rows=[]
    for name, provider in owners.items():
        node, _ = inventory.get(name, ({}, None))
        history=node.get('history')
        last=history[-1] if isinstance(history, list) and history and isinstance(history[-1], dict) else {}
        delay=last.get('delay')
        delay=delay if type(delay) in (int, float) and delay > 0 else None
        # Prefer this tool's explicitly measured baseline; label its timestamp in the UI.
        row={'name':name,'provider':runtime.provider_label(provider) or 'Clash',
             'delay':delay,'time':last.get('time',''),
             'status':'历史可达' if delay else '未验证',
             'source':'Clash 历史健康检查','error':''}
        for record in records:
            saved = record.get('results', {}).get(name, {})
            if saved.get('owner') in (None, provider):
                row.update(saved)
        rows.append(row)
    return rows

def snapshot(include_nodes=True):
    c,p=t.state()
    selection = runtime.read_json('node-policy.json').get('selected_nodes')
    live=p.get(t.ENTRY,{}).get('all',[])
    owners=t.relay_owners(selection, live)
    data={'mode':c.get('mode'), 'tun':c.get('tun',{}).get('enable',False),'exit':p.get('GLOBAL',{}).get('now','未知'),'entry':p.get(t.ENTRY,{}).get('now','未知'),'dialer':p.get(t.EXIT,{}).get('dialer-proxy'),'nodes':list(owners),'live':live,'expected_ip':runtime.expected_ip()}
    if include_nodes:
        try:data['node_rows']=node_rows(p, owners)
        except Exception as e:data['node_rows_error']=str(e)
    return data

def latency():
    from chain_test import clear_latest_results, save_benchmark
    lock=open(t.BASE/'latency.lock','a')
    try:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise RuntimeError('已有一轮节点测速正在运行，请稍后再试')
        clear_latest_results()
        before=snapshot(False);_,p=t.state();results={}
        owners = t.relay_owners(runtime.read_json('node-policy.json').get('selected_nodes'), before.get('live', []))
        inventory = t.node_inventory(p, owners)
        def measure(name):
            _,provider=inventory.get(name,({},None))
            provider=owners.get(name, provider)
            row={'owner':owners.get(name),'time':datetime.datetime.now().astimezone().isoformat(timespec='seconds'),'source':'入口 HTTPS 204，单次 / 3 秒超时','error':''}
            try:
                d=clash.entry_delay(name, provider)
                if not policy.entrance_delay_accepted(d):raise RuntimeError('未返回有效延迟')
                row.update(delay=d,status='实测可达')
            except Exception as e:row.update(delay=None,status='未响应',error=str(e))
            return name,row
        progress=t.BASE/'latency-progress.json'
        def publish():
            tmp=progress.with_suffix('.tmp')
            tmp.write_text(json.dumps({'index':len(results),'total':len(before['nodes']),
                'running':list(pending.values()),'results':results,'names':before['nodes']},ensure_ascii=False))
            tmp.chmod(0o600);os.replace(tmp,progress)
        pending={};remaining=iter(before['nodes'])
        with ThreadPoolExecutor(max_workers=runtime.CONCURRENCY,thread_name_prefix='entrance-test') as pool:
            while True:
                for future in list(pending):
                    if future.done():
                        name,row=future.result();results[name]=row;del pending[future]
                while len(pending)<runtime.CONCURRENCY:
                    name=next(remaining,None)
                    if name is None:break
                    pending[pool.submit(measure,name)]=name
                publish()
                if not pending:break
                wait(pending,timeout=policy.PARAMETERS['entrance_wait_seconds'],return_when=FIRST_COMPLETED)
        after=snapshot(False)
        unchanged=all(before.get(k)==after.get(k) for k in ['mode','entry','exit','dialer','tun','live'])
        save_benchmark('latency', {
            'finished_at': datetime.datetime.now().astimezone().isoformat(),
            'results': results, 'selection_unchanged': unchanged,
        })
        return {'state':snapshot(),'message':f'入口测速完成：{sum(x["delay"] is not None for x in results.values())}/{len(results)} 本次可达。'+('当前链路未改变。' if unchanged else '检测到外部代理状态变化，请核对。')+' 仅作入口参考，不代表美国完整链路或下载速度。'}
    finally:lock.close()

@t.switch_lock()
def change(target,previous,guard=None):
    s=snapshot()
    if not policy.chain_allowed(s,t.EXIT,t.ENTRY):
        raise RuntimeError('当前全局链路与预期不符，已取消。请先在 Clash 恢复全局 → 美国静态家宽。')
    owners = t.switch_owners(s['live'])
    if not policy.target_available(s['entry'],previous,target,owners):
        raise RuntimeError('节点状态已变化，请刷新后重新选择。')
    owner = owners[target]
    if guard is not None:
        import chain_test
        if not policy.switch_allowed(chain_test.physical_network()==guard['network'] and chain_test.active_state()[0]==guard['before']):
            raise RuntimeError('当前网络或节点已变化，未自动切换。')
        nodes,exit_node,expected=chain_test.load_nodes()
        same_routing = target in nodes and chain_test.routing_fingerprint(
            nodes,exit_node,expected,chain_test.DNS_POLICY,previous,target)==guard.get('routing_fingerprint')
        if not policy.switch_allowed(same_routing,cancelled=same_routing and (t.BASE/'chain-cancel').exists()):
            raise RuntimeError('节点配置已变化或测速已停止，未自动切换。')
        fresh_owners = t.switch_owners(s['live'])
        if not policy.target_owner_matches(fresh_owners,target,owner):
            raise RuntimeError('节点归属已变化，请先更新订阅')
    if target==previous:return {'message':'已经是该节点，没有修改。','state':s}
    clash.switch_entry(target)
    after=snapshot()
    if after['entry']!=target or not policy.chain_allowed(after,t.EXIT,t.ENTRY):
        raise RuntimeError('操作后状态与预期不符，请刷新并检查 Clash；没有继续更改。')
    after_owners = t.switch_owners(after['live'])
    if not policy.target_owner_matches(after_owners,target,owner):
        raise RuntimeError('切换后的节点归属待核对，请刷新 Clash 状态')
    warning=''
    try:t.persist_selection(target)
    except Exception as e:warning='实时切换成功，但保存选择失败：'+str(e)
    return {'message':warning or '已切换中转入口，美国静态出口保持不变。建议运行网络检查。','state':after}


def remove_list_nodes(request, metric='chain'):
    import subscription_update
    result = subscription_update.run(metric, removal=request)
    return {**result, 'state': snapshot()}


def ip_info():
    # Explicitly use Clash. A failed proxy request must never silently go direct.
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({'https':'http://127.0.0.1:7897'}),urllib.request.HTTPSHandler(context=runtime.ssl_context()))
    with opener.open('https://ipwho.is/',timeout=15) as response:
        data=json.load(response)
    if data.get('success') is not True:
        raise RuntimeError(data.get('message','IP 查询失败'))
    return {'ip':data.get('ip'), 'country':data.get('country'), 'region':data.get('region'),
            'city':data.get('city'), 'connection':data.get('connection',{}),
            'timezone':data.get('timezone',{}).get('id'),
            'updated_at':datetime.datetime.now().astimezone().strftime('%H:%M:%S'),
            'source':'https://ipwho.is/'}

def startup(metric, *flags):
    import subscription_picker
    before = t.relay_state()
    ready = before['mode'] == 'global' and before['exit'] == t.EXIT and before['dialer'] == t.ENTRY
    result = {'startup_checked': ready}
    if ready:
        try:
            result['initialized'] = subscription_picker.initialize(metric)
            if result['initialized'] and '--refresh' in flags:
                result['message'] = '已刷新 Clash 状态。'
        except RuntimeError as error:
            result.update(startup_checked=False, message=str(error))
    result['state'] = snapshot()
    return result


def catalog(*flags):
    import subscription_picker
    changes = json.load(sys.stdin) if '--draft' in flags else []
    return {'catalog': subscription_picker.merge_selection_draft(subscription_picker.catalog(), changes)}


def save_selection(metric):
    import subscription_picker
    return {**subscription_picker.apply(json.load(sys.stdin), metric), 'state': snapshot()}


def update_subscriptions(metric):
    import subscription_picker
    return {**subscription_picker.synchronize(metric), 'state': snapshot()}


def chain(concurrency=runtime.CONCURRENCY, metric=None):
    import chain_test
    message, record, tested = chain_test.run(int(concurrency))
    result = {'message': message, 'state': snapshot()}
    if metric is not None and (target := policy.recommendation(record, metric)):
        result['recommendation'] = {
            'target': target, 'before': record['before'], 'network': record['network'],
            'routing_fingerprint': chain_test.routing_fingerprint(*tested, record['before']['entry'], target),
        }
    return result


def check():
    import network_check
    import io
    import contextlib
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        network_check.main()
    return {'message': '检查完成；可在检测页面下载报告。', 'details': output.getvalue()}


def read_benchmark_settings(*flags):
    return {'settings': benchmark_settings(json.load(sys.stdin), strict='--save' in flags)}


COMMANDS = {
    'startup': startup,
    'subscription-catalog': catalog,
    'save-node-selection': save_selection,
    'update-subscriptions': update_subscriptions,
    'remove-list-nodes': lambda metric: remove_list_nodes(json.load(sys.stdin), metric),
    'chain': chain,
    'ip-info': lambda: {'ip_info': ip_info()},
    'switch': lambda target, previous: change(target, previous),
    'auto-switch': lambda target, previous: change(target, previous, json.load(sys.stdin)),
    'check': check,
    'benchmark-settings': read_benchmark_settings,
    # These commands remain available for packaging and direct backend use.
    'self-test': lambda: {'concurrency': runtime.CONCURRENCY, 'bundled_backend': True},
    'status': lambda: {'state': snapshot()},
    'latency': latency,
}


def main():
    action, *args = sys.argv[1:]
    command = COMMANDS.get(action)
    if command is None:
        raise RuntimeError('未知操作')
    result = command(*args)
    print(json.dumps({'ok': True, **result}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except SettingsError as error:
        print(json.dumps({'ok': False, 'error': str(error), 'field': error.field}, ensure_ascii=False))
        sys.exit(1)
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
        sys.exit(1)
