"""Isolated bounded-parallel proxy-chain tests. Never writes to the running Clash API."""
import copy
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from threading import Event
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import socket
import statistics
import subprocess
import tempfile
import time
import yaml
import toolbox as t
import runtime
from reconcile import selection_owners

CORE = '/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo'
CONFIG_DIR = runtime.CONFIG_DIR
DNS_POLICY = {}
TARGET = 'https://www.cloudflare.com/cdn-cgi/trace'


def write_json(path, obj):
    tmp=path.with_suffix('.tmp')
    tmp.write_text(json.dumps(obj,ensure_ascii=False,indent=2));tmp.chmod(0o600);os.replace(tmp,path)


def clear_latest_results():
    write_json(t.BASE / 'latest-benchmark.json', {'kind': None})


def save_benchmark(kind, record):
    write_json(t.BASE / (kind + '-results.json'), record)
    write_json(t.BASE / 'latest-benchmark.json', {'kind': kind})


def physical_network():
    result=subprocess.run(['/usr/sbin/scutil'],input='show State:/Network/Global/IPv4\n',capture_output=True,text=True,timeout=5).stdout
    match=re.search(r'PrimaryInterface\s*:\s*(\S+)',result)
    router=re.search(r'Router\s*:\s*(\S+)',result)
    if not match or not re.fullmatch(r'en\d+',match[1]):
        raise RuntimeError('无法确认有线 / Wi-Fi 物理接口，拒绝测速以避免重复经过当前 TUN')
    interface=match[1]
    addr=subprocess.run(['/usr/sbin/ipconfig','getifaddr',interface],capture_output=True,text=True,timeout=5).stdout.strip()
    if not addr:raise RuntimeError('物理网络没有 IPv4 地址')
    return {'interface':interface,'address':addr,'router':router[1] if router else ''}


def active_state():
    state = t.relay_state()
    selection = runtime.read_json('node-policy.json').get('selected_nodes')
    return state, list(t.relay_owners(selection, state['live']))


def load_nodes():
    from subscription_update import entry_plan

    global DNS_POLICY
    conf = yaml.safe_load((CONFIG_DIR / 'clash-verge.yaml').read_text())
    DNS_POLICY = {k: v for k, v in conf.get('dns', {}).get('proxy-server-nameserver-policy', {}).items()
                  if not k.startswith(('geosite:', 'rule-set:'))}
    selection = runtime.read_json('node-policy.json').get('selected_nodes')
    owners = selection_owners(selection)
    nodes = {}
    if selection is None:
        nodes = {name: node for name, (_, node) in (entry_plan(conf, CONFIG_DIR) or {}).items() if node is not None}
    providers = conf.get('proxy-providers', {})
    for owner in dict.fromkeys(owners.values()):
        provider = providers.get(owner, {})
        if not isinstance(provider, dict):
            continue
        if provider.get('path'):
            try:
                data = yaml.safe_load((CONFIG_DIR / provider['path']).read_text())
            except (OSError, ValueError, yaml.YAMLError):
                continue
            proxies = data.get('proxies') if isinstance(data, dict) else None
        else:
            proxies = provider.get('payload')
        if isinstance(proxies, list):
            for node in proxies:
                if isinstance(node, dict) and isinstance(node.get('name'), str) and owners.get(node['name']) == owner:
                    nodes.setdefault(node['name'], node)
    exit_node = next((n for n in conf.get('proxies', []) if n['name'] == t.EXIT), None)
    expected = runtime.expected_ip(conf)
    if not exit_node or not expected:
        raise RuntimeError('找不到固定出口配置或有效的预期出口 IP')
    if exit_node.get('dialer-proxy') != t.ENTRY:
        raise RuntimeError('固定出口的链式上游已变化，未开始测试')
    return nodes, exit_node, expected


def isolated_config(entry, exit_node, port, interface):
    a=copy.deepcopy(entry);b=copy.deepcopy(exit_node)
    if a.get('dialer-proxy'):raise RuntimeError('入口自带其他链式上游，暂不支持隔离测速')
    a['name']='TEST_ENTRY';a['interface-name']=interface
    b['name']='TEST_US_EXIT';b['dialer-proxy']='TEST_ENTRY';b.pop('interface-name',None)
    return {'mixed-port':port,'bind-address':'127.0.0.1','allow-lan':False,
            'mode':'rule','log-level':'silent','ipv6':False,'interface-name':interface,
            'external-controller':'','tun':{'enable':False},'find-process-mode':'off',
            'profile':{'store-selected':False,'store-fake-ip':False},
            'dns':{'enable':True,'ipv6':False,'enhanced-mode':'normal',
                   'default-nameserver':['223.5.5.5','119.29.29.29'],
                   'nameserver':['https://dns.alidns.com/dns-query'],
                   'proxy-server-nameserver':['https://dns.alidns.com/dns-query'],
                   'nameserver-policy':DNS_POLICY,'proxy-server-nameserver-policy':DNS_POLICY},
            'proxies':[a,b],'proxy-groups':[],'rules':['DOMAIN,www.gstatic.com,TEST_ENTRY','MATCH,TEST_US_EXIT']}


def stop_owned(process):
    # Only the exact Popen child created by this module. Never pkill/killall.
    if process.poll() is None:
        process.terminate()
        try:process.wait(timeout=2)
        except subprocess.TimeoutExpired:process.kill();process.wait(timeout=2)


def trace(port, cancelled, expected):
    command=['/usr/bin/curl','--silent','--show-error','--proxy',f'http://127.0.0.1:{port}',
             '--noproxy','','--connect-timeout','8','--max-time','12','--max-filesize','16384',
             '--write-out','\n__TIMING__%{http_code} %{time_total} %{time_starttransfer}',TARGET]
    p=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    deadline=time.monotonic()+14
    try:
        while p.poll() is None:
            if cancelled() or time.monotonic()>deadline:
                stop_owned(p);raise RuntimeError('测试取消或请求超时')
            time.sleep(.1)
        stdout,stderr=p.communicate()
        if p.returncode:raise RuntimeError('请求失败 / 超时（curl '+str(p.returncode)+'）')
        text=stdout.decode(errors='replace');body,stats=text.rsplit('\n__TIMING__',1)
        code,total,ttfb=stats.split();values=dict(x.split('=',1) for x in body.splitlines() if '=' in x)
        if code!='200' or not values.get('ip'):raise RuntimeError('测试站返回无效结果')
        if values['ip']!=expected:raise RuntimeError('出口不符：'+values['ip'])
        return {'ms':round(float(total)*1000),'ttfb_ms':round(float(ttfb)*1000),'ip':values['ip']}
    finally:stop_owned(p)


def entrance_delay(port,cancelled):
    """The isolated core routes this exact host through TEST_ENTRY only."""
    command=['/usr/bin/curl','--silent','--show-error','--proxy',f'http://127.0.0.1:{port}',
             '--noproxy','','--connect-timeout','3','--max-time','3','--max-filesize','1024',
             '--output','/dev/null','--write-out','%{http_code} %{time_total}',
             'https://www.gstatic.com/generate_204']
    process=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        deadline=time.monotonic()+4
        while process.poll() is None:
            if cancelled() or time.monotonic()>deadline:raise RuntimeError('入口测试取消或超时')
            time.sleep(.05)
        stdout,_=process.communicate()
        if process.returncode:raise RuntimeError('入口请求失败')
        code,total=stdout.decode().split()
        if code!='204':raise RuntimeError('入口响应非 204')
        return max(1,round(float(total)*1000))
    finally:stop_owned(process)


def test_node(node, exit_node, network, cancelled, expected):
    # Unique private directory and one non-TUN child; secrets removed in finally.
    with tempfile.TemporaryDirectory(prefix='proxy-chain-') as tmp:
        folder=Path(tmp);folder.chmod(0o700)
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        config=isolated_config(node,exit_node,port,network['interface'])
        path=folder/'config.yaml';path.write_text(yaml.safe_dump(config,allow_unicode=True));path.chmod(0o600)
        p=subprocess.Popen([CORE,'-d',str(folder),'-f',str(path)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        try:
            ready=False
            for _ in range(40):
                if cancelled():raise RuntimeError('测试取消')
                if p.poll() is not None:raise RuntimeError('隔离内核未能启动')
                try:
                    with socket.create_connection(('127.0.0.1',port),timeout=.1):ready=True
                    break
                except OSError:time.sleep(.1)
            if not ready:raise RuntimeError('隔离端口未就绪')
            owner=subprocess.run(['/usr/sbin/lsof','-nP','-a','-p',str(p.pid),f'-iTCP:{port}','-sTCP:LISTEN'],capture_output=True,text=True,timeout=3)
            if owner.returncode!=0:raise RuntimeError('无法确认临时端口归属，已停止测试')
            entrance={'delay':None,'time':dt.datetime.now().astimezone().isoformat(timespec='seconds'),'source':'隔离入口 HTTPS 204 / 3 秒超时','error':''}
            try:entrance['delay']=entrance_delay(port,cancelled)
            except Exception as error:entrance['error']=str(error)
            samples=[];errors=[]
            for index in range(3):
                if cancelled():break
                try:samples.append(trace(port,cancelled,expected))
                except RuntimeError as error:errors.append(str(error))
                if errors and not samples:break  # avoid repeatedly probing a failing path
                time.sleep(.25)
            return samples,errors,entrance
        finally:stop_owned(p)


def routing_fingerprint(nodes, exit_node, expected, dns_policy, current, target):
    data=[nodes.get(current),nodes[target],exit_node,dns_policy,expected]
    return hashlib.sha256(json.dumps(data,sort_keys=True,ensure_ascii=False).encode()).hexdigest()


def auto_candidate(record, metric):
    if metric not in ('entrance','chain') or record['reason'] or not record['selection_unchanged']:
        return None
    current=record['before']['entry']
    results=record['results']
    key='delay' if metric=='entrance' else 'chain_delay'
    def delay(row, field):
        value=row.get(field)
        return value if type(value) is int and value>0 else None
    if current not in results:
        return None
    choices=[(delay(row,key),name) for name,row in results.items()
             if name!=current and delay(row,'chain_delay') and delay(row,key)]
    if not choices:
        return None
    fastest,name=min(choices)
    baseline=delay(results[current],key)
    if not delay(results[current],'chain_delay') or (baseline and baseline-fastest>=max(20,baseline*.10)):
        return name
    return None


def run(concurrency=runtime.CONCURRENCY):
    if type(concurrency) is not int or not 1 <= concurrency <= 10:
        raise ValueError("并发测速量须为 1–10")
    os.umask(0o077)
    with open(t.BASE/'latency.lock','a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise RuntimeError('已有一轮测速运行，请等待完成')
        clear_latest_results()
        cancel=t.BASE/'chain-cancel';cancel.unlink(missing_ok=True)
        parent=os.getppid()
        cancelled=lambda:cancel.exists() or os.getppid()!=parent
        before,names=active_state();network=physical_network();nodes,exit_node,expected=load_nodes();dns_policy=DNS_POLICY
        owners = t.relay_owners(runtime.read_json('node-policy.json').get('selected_nodes'), before.get('live', []))
        if before['mode']!='global' or before['exit']!=t.EXIT or before['dialer']!=t.ENTRY:raise RuntimeError('当前链式配置与预期不符，未开始测试')
        results={};run_id=secrets.token_hex(8);progress=t.BASE/'chain-progress.json'
        running=[]
        def publish(index,name,message):
            write_json(progress,{'running':running,'results':results,'names':names,'run_id':run_id,'index':index,'total':len(names),'node':name,'message':message,'time':dt.datetime.now().astimezone().isoformat()})
        publish(0,'','隔离全链路测试准备完成')
        reason='';started=dt.datetime.now().astimezone().isoformat()
        stop=Event()
        external_cancelled=cancelled
        cancelled=lambda:stop.is_set() or external_cancelled()
        def measure(name):
            row={'chain_time':dt.datetime.now().astimezone().isoformat(timespec='seconds'),
                 'chain_delay':None,'chain_status':'未验证','chain_samples':[], 'chain_error':'',
                 'owner':owners.get(name), 'chain_interface':network['interface'],'chain_target':TARGET,'chain_ip':None,'delay':None}
            try:
                if name not in nodes:raise RuntimeError('本地缓存缺少节点凭据，请在 Clash 更新订阅后再试')
                samples,errors,entrance=test_node(nodes[name],exit_node,network,cancelled,expected)
                row.update(entrance)
                row['chain_samples']=samples;row['chain_error']='；'.join(errors)
                if samples:row['chain_ip']=samples[0]['ip']
                if len(samples)>=2:
                    row['chain_delay']=round(statistics.median(x['ms'] for x in samples))
                    row['chain_status']=f'全链 {len(samples)}/3'
                else:row['chain_status']='不足 2 次' if samples else '全链未通'
            except Exception as e:row['chain_status']='全链未通';row['chain_error']=str(e)
            return row
        # Coordinator alone checks state and writes progress; workers own their children.
        pending={};remaining=iter(names)
        with ThreadPoolExecutor(max_workers=concurrency,thread_name_prefix='chain-test') as pool:
            try:
                while True:
                    if external_cancelled():reason='已停止，保留已完成结果';break
                    if physical_network()!=network or active_state()[0]!=before:
                        reason='检测到网络或当前链路变化，已停止；没有恢复或改动用户配置';break
                    # Only accept results after confirming the original network and chain.
                    for future in list(pending):
                        if future.done():results[pending.pop(future)]=future.result()
                    while len(pending)<concurrency:
                        name=next(remaining,None)
                        if name is None:break
                        pending[pool.submit(measure,name)]=name
                    running=list(pending.values())
                    publish(len(results),'、'.join(pending.values()),'正在隔离测速')
                    if not pending:break
                    wait(pending,timeout=.3,return_when=FIRST_COMPLETED)
            finally:
                stop.set()
                for future in pending:future.cancel()
        after,_=active_state();unchanged=after==before
        record={'finished_at':dt.datetime.now().astimezone().isoformat(),'started_at':started,'network':network,'expected_ip':expected,'results':results,
                'before':before,'after':after,'selection_unchanged':unchanged,'reason':reason}
        save_benchmark('chain', record)
        directory=t.BASE/'chain-reports';directory.mkdir(exist_ok=True)
        write_json(directory/(dt.datetime.now().strftime('%Y%m%d-%H%M%S')+'.json'),record)
        good=sum(x['chain_delay'] is not None for x in results.values())
        message=(reason+'。' if reason else '')+f'全链路测速完成：{good}/{len(results)} 条获得有效延迟；'+('当前链路未改变。' if unchanged else '检测到外部链路变化。')+'已清理临时测试进程。'
        running=[]
        publish(len(results),'',message)
        return message,record,(nodes,exit_node,expected,dns_policy)
