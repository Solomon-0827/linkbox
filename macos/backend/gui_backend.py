#!/usr/bin/env python3
import json
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
import subprocess
import sys
import urllib.parse
import urllib.request
import datetime
import fcntl
import os
import toolbox as t
import runtime
from reconcile import selection_owners

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
        query=urllib.parse.urlencode({'url':'https://www.gstatic.com/generate_204','timeout':3000,'expected':'204'})
        def measure(name):
            _,provider=inventory.get(name,({},None))
            provider=owners.get(name, provider)
            q=urllib.parse.quote
            route=('/providers/proxies/'+q(provider,safe='')+'/'+q(name,safe='')+'/healthcheck') if provider else '/proxies/'+q(name,safe='')+'/delay'
            row={'owner':owners.get(name),'time':datetime.datetime.now().astimezone().isoformat(timespec='seconds'),'source':'入口 HTTPS 204，单次 / 3 秒超时','error':''}
            try:
                d=t.api('GET',route+'?'+query).get('delay')
                if not isinstance(d,(int,float)) or d<=0:raise RuntimeError('未返回有效延迟')
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
                wait(pending,timeout=.2,return_when=FIRST_COMPLETED)
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
    if s['mode']!='global' or s['exit']!=t.EXIT or s['dialer']!=t.ENTRY:
        raise RuntimeError('当前全局链路与预期不符，已取消。请先在 Clash 恢复全局 → 美国静态家宽。')
    plan = t.live_entry_plan(s['live'])
    if plan is None:
        raise RuntimeError(t.ENTRY_NOT_APPLIED)
    if s['entry']!=previous or target not in plan:
        raise RuntimeError('节点状态已变化，请刷新后重新选择。')
    owner = plan[target][0]
    if guard is not None:
        import chain_test
        if chain_test.physical_network()!=guard['network'] or chain_test.active_state()[0]!=guard['before']:
            raise RuntimeError('当前网络或节点已变化，未自动切换。')
        nodes,exit_node,expected=chain_test.load_nodes()
        if (target not in nodes or chain_test.routing_fingerprint(nodes,exit_node,expected,chain_test.DNS_POLICY,previous,target)!=guard.get('routing_fingerprint') or
                (t.BASE/'chain-cancel').exists()):
            raise RuntimeError('节点配置已变化或测速已停止，未自动切换。')
        selection = runtime.read_json('node-policy.json').get('selected_nodes')
        if selection is not None and selection_owners(selection).get(target) != owner:
            raise RuntimeError('节点归属已变化，请先更新订阅')
    if target==previous:return {'message':'已经是该节点，没有修改。','state':s}
    t.api('PUT','/proxies/'+urllib.parse.quote(t.ENTRY,safe=''),{'name':target})
    after=snapshot()
    if after['entry']!=target or after['exit']!=t.EXIT or after['mode']!='global' or after['dialer']!=t.ENTRY:
        raise RuntimeError('操作后状态与预期不符，请刷新并检查 Clash；没有继续更改。')
    after_plan = t.live_entry_plan(after['live'])
    if not t.same_switch_target(plan, after_plan, target):
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

def main():
    action=sys.argv[1]
    if action=='self-test': result={'concurrency':runtime.CONCURRENCY,'bundled_backend':True}
    elif action=='status': result={'state':snapshot()}
    elif action=='startup':
        import subscription_picker
        from subscription_update import RECOVERY_HINT
        before = t.relay_state()
        ready = before['mode'] == 'global' and before['exit'] == t.EXIT and before['dialer'] == t.ENTRY
        result = {'startup_checked': ready}
        if ready or runtime.read_json('node-policy.json').get('pending_update') is not None:
            try:
                result['initialized'] = subscription_picker.initialize(sys.argv[2])
                if result['initialized'] and '--refresh' in sys.argv[3:]:
                    result['message'] = '已刷新 Clash 状态。'
            except Exception as error:
                if runtime.read_json('node-policy.json').get('pending_update') is not None:
                    result['recovery_hint'] = RECOVERY_HINT
                elif isinstance(error, RuntimeError):
                    result.update(startup_checked=False, message=str(error))
                else:
                    raise
        result['state'] = snapshot()
    elif action=='subscription-catalog':
        import subscription_picker
        result={'catalog':subscription_picker.catalog()}
    elif action=='save-node-selection':
        import subscription_picker
        result=subscription_picker.apply(json.load(sys.stdin), sys.argv[2])
        result['state']=snapshot()
    elif action=='update-subscriptions':
        import subscription_picker
        result=subscription_picker.synchronize(sys.argv[2])
        result['state']=snapshot()
    elif action=='remove-list-nodes':result=remove_list_nodes(json.load(sys.stdin), sys.argv[2])
    elif action=='latency':result=latency()
    elif action=='chain':
        import chain_test
        message,record,tested=chain_test.run(int(sys.argv[2]) if len(sys.argv)>2 else runtime.CONCURRENCY)
        result={'message':message,'state':snapshot()}
        if len(sys.argv)>3 and (target:=chain_test.auto_candidate(record,sys.argv[3])):
            result['recommendation']={'target':target,'before':record['before'],'network':record['network'],
                                      'routing_fingerprint':chain_test.routing_fingerprint(*tested,record['before']['entry'],target)}
    elif action=='ip-info':result={'ip_info':ip_info()}
    elif action=='switch':result=change(sys.argv[2],sys.argv[3])
    elif action=='auto-switch':result=change(sys.argv[2],sys.argv[3],json.load(sys.stdin))
    elif action=='check':
        import network_check,io,contextlib
        output=io.StringIO()
        with contextlib.redirect_stdout(output):network_check.main()
        result={'message':'检查完成；可在检测页面下载报告。','details':output.getvalue()}
    else:raise RuntimeError('未知操作')
    print(json.dumps({'ok':True,**result},ensure_ascii=False))

if __name__=='__main__':
    try:main()
    except Exception as e:
        print(json.dumps({'ok':False,'error':str(e)},ensure_ascii=False));sys.exit(1)
