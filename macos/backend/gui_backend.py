#!/usr/bin/env python3
import json
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from pathlib import Path
import subprocess
import sys
import urllib.parse
import urllib.request
import datetime
import time
import fcntl
import os
import toolbox as t
import runtime

def node_inventory(p):
    return t.node_inventory(p)

def node_rows(p):
    inventory=node_inventory(p)
    cache={}
    try:cache=json.loads((t.BASE/'latency-results.json').read_text()).get('results',{})
    except (OSError,ValueError):pass
    chains={}
    try:chains=json.loads((t.BASE/'chain-results.json').read_text()).get('results',{})
    except (OSError,ValueError):pass
    rows=[]
    for name in p.get(t.ENTRY,{}).get('all',[]):
        node,provider=inventory.get(name,({},None))
        provider=runtime.provider_for(name,provider or '本地节点')
        if not runtime.allowed(name,provider):continue
        history=node.get('history',[])
        last=history[-1] if history else {}
        saved=cache.get(name)
        # Prefer this tool's explicitly measured baseline; label its timestamp in the UI.
        row={'name':name,'provider':provider,
             'delay':last.get('delay') or None,'time':last.get('time',''),
             'status':'历史可达' if last.get('delay',0)>0 else '未验证',
             'source':'Clash 历史健康检查','error':''}
        if saved:row.update(saved)
        row.update(chains.get(name,{}))
        rows.append(row)
    return rows

def snapshot(include_nodes=True):
    c,p=t.state()
    data={'mode':c.get('mode'), 'tun':c.get('tun',{}).get('enable',False),'exit':p.get('GLOBAL',{}).get('now','未知'),'entry':p.get(t.ENTRY,{}).get('now','未知'),'dialer':p.get(t.EXIT,{}).get('dialer-proxy'),'nodes':t.candidate_names(p),'expected_ip':runtime.expected_ip()}
    if include_nodes:
        try:data['node_rows']=node_rows(p)
        except Exception as e:data['node_rows_error']=str(e)
    return data

def latency():
    lock=open(t.BASE/'latency.lock','a')
    try:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise RuntimeError('已有一轮节点测速正在运行，请稍后再试')
        before=snapshot(False);_,p=t.state();inventory=node_inventory(p);results={}
        query=urllib.parse.urlencode({'url':'https://www.gstatic.com/generate_204','timeout':3000,'expected':'204'})
        def measure(name):
            _,provider=inventory.get(name,({},None))
            q=urllib.parse.quote
            route=('/providers/proxies/'+q(provider,safe='')+'/'+q(name,safe='')+'/healthcheck') if provider else '/proxies/'+q(name,safe='')+'/delay'
            row={'time':datetime.datetime.now().astimezone().isoformat(timespec='seconds'),'source':'入口 HTTPS 204，单次 / 3 秒超时','error':''}
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
        cache=t.BASE/'latency-results.json'
        temp=cache.with_suffix('.tmp');temp.write_text(json.dumps({'finished_at':datetime.datetime.now().astimezone().isoformat(),'results':results},ensure_ascii=False,indent=2));temp.chmod(0o600);os.replace(temp,cache)
        after=snapshot()
        unchanged=all(before.get(k)==after.get(k) for k in ['mode','entry','exit','dialer','tun'])
        return {'state':after,'message':f'入口测速完成：{sum(x["delay"] is not None for x in results.values())}/{len(results)} 本次可达。'+('当前链路未改变。' if unchanged else '检测到外部代理状态变化，请核对。')+' 仅作入口参考，不代表美国完整链路或下载速度。'}
    finally:lock.close()

def change(target,previous):
    s=snapshot()
    if s['mode']!='global' or s['exit']!=t.EXIT or s['dialer']!=t.ENTRY:
        raise RuntimeError('当前全局链路与预期不符，已取消。请先在 Clash 恢复全局 → 美国静态家宽。')
    if s['entry']!=previous or target not in s['nodes']:
        raise RuntimeError('节点状态已变化，请刷新后重新选择。')
    if target==previous:return {'message':'已经是该节点，没有修改。','state':s}
    t.api('PUT','/proxies/'+urllib.parse.quote(t.ENTRY,safe=''),{'name':target})
    after=snapshot()
    if after['entry']!=target or after['exit']!=t.EXIT or after['mode']!='global':
        raise RuntimeError('操作后状态与预期不符，请刷新并检查 Clash；没有继续更改。')
    warning=''
    try:t.persist_selection(target)
    except Exception as e:warning='实时切换成功，但保存选择失败：'+str(e)
    return {'message':warning or '已切换中转入口，美国静态出口保持不变。建议运行网络检查。','state':after}


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
    elif action=='update-subscriptions':
        import subscription_update
        result=subscription_update.run()
        result['state']=snapshot()
    elif action=='latency':result=latency()
    elif action=='chain':
        import chain_test
        message=chain_test.run()
        result={'message':message,'state':snapshot()}
    elif action=='ip-info':result={'ip_info':ip_info()}
    elif action=='switch':result=change(sys.argv[2],sys.argv[3])
    elif action=='check':
        import network_check,io,contextlib
        output=io.StringIO()
        with contextlib.redirect_stdout(output):network_check.main()
        result={'message':'检查完成；报告保存在本机。','details':output.getvalue()}
    else:raise RuntimeError('未知操作')
    print(json.dumps({'ok':True,**result},ensure_ascii=False))

if __name__=='__main__':
    try:main()
    except Exception as e:
        print(json.dumps({'ok':False,'error':str(e)},ensure_ascii=False));sys.exit(1)
