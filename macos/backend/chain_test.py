"""Isolated bounded-parallel proxy-chain tests. Never writes to the running Clash API."""
import copy
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from threading import Event
import datetime as dt
import fcntl
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

CORE = '/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo'
CONFIG_DIR = runtime.CONFIG_DIR
EXPECTED = runtime.expected_ip()
DNS_POLICY = {}
TARGET = 'https://www.cloudflare.com/cdn-cgi/trace'


def write_json(path, obj):
    tmp=path.with_suffix('.tmp')
    tmp.write_text(json.dumps(obj,ensure_ascii=False,indent=2));tmp.chmod(0o600);os.replace(tmp,path)


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
    c,p=t.state()
    return {'mode':c.get('mode'),'tun':c.get('tun',{}).get('enable'),
            'entry':p.get(t.ENTRY,{}).get('now'),'exit':p.get('GLOBAL',{}).get('now'),
            'dialer':p.get(t.EXIT,{}).get('dialer-proxy')},t.candidate_names(p)


def load_nodes():
    global DNS_POLICY
    conf=yaml.safe_load((CONFIG_DIR/'clash-verge.yaml').read_text())
    DNS_POLICY={k:v for k,v in conf.get('dns',{}).get('proxy-server-nameserver-policy',{}).items() if not k.startswith(('geosite:','rule-set:'))}
    nodes={x['name']:x for x in conf.get('proxies',[])}
    for provider in conf.get('proxy-providers',{}).values():
        if provider.get('path'):
            p=Path(provider['path']);p=p if p.is_absolute() else CONFIG_DIR/p
            data=yaml.safe_load(p.read_text())
        else:data={'proxies':provider.get('payload',[])}
        for node in data.get('proxies',[]):
            if node['name']!=runtime.read_json('node-policy.json').get('pinned_entry'):nodes[node['name']]=node
    exit_node=nodes.get(t.EXIT)
    if not exit_node:raise RuntimeError('找不到美国静态出口配置')
    if exit_node.get('server')!=EXPECTED:raise RuntimeError('美国出口服务器已变化，请先更新预期出口，未开始测试')
    return nodes,exit_node


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


def trace(port, cancelled):
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
        if values['ip']!=EXPECTED:raise RuntimeError('出口不符：'+values['ip'])
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


def test_node(node, exit_node, network, cancelled):
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
                try:samples.append(trace(port,cancelled))
                except RuntimeError as error:errors.append(str(error))
                if errors and not samples:break  # avoid repeatedly probing a failing path
                time.sleep(.25)
            return samples,errors,entrance
        finally:stop_owned(p)


def run():
    os.umask(0o077)
    with open(t.BASE/'latency.lock','a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise RuntimeError('已有一轮测速运行，请等待完成')
        cancel=t.BASE/'chain-cancel';cancel.unlink(missing_ok=True)
        parent=os.getppid()
        cancelled=lambda:cancel.exists() or os.getppid()!=parent
        before,names=active_state();network=physical_network();nodes,exit_node=load_nodes()
        if before['exit']!=t.EXIT or before['dialer']!=t.ENTRY:raise RuntimeError('当前链式配置与预期不符，未开始测试')
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
                 'chain_interface':network['interface'],'chain_target':TARGET,'chain_ip':None,'delay':None}
            try:
                if name not in nodes:raise RuntimeError('本地缓存缺少节点凭据，请在 Clash 更新订阅后再试')
                samples,errors,entrance=test_node(nodes[name],exit_node,network,cancelled)
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
        with ThreadPoolExecutor(max_workers=runtime.CONCURRENCY,thread_name_prefix='chain-test') as pool:
            try:
                while True:
                    if external_cancelled():reason='已停止，保留已完成结果';break
                    if physical_network()!=network or active_state()[0]!=before:
                        reason='检测到网络或当前链路变化，已停止；没有恢复或改动用户配置';break
                    # Only accept results after confirming the original network and chain.
                    for future in list(pending):
                        if future.done():results[pending.pop(future)]=future.result()
                    while len(pending)<runtime.CONCURRENCY:
                        name=next(remaining,None)
                        if name is None:break
                        pending[pool.submit(measure,name)]=name
                    running=list(pending.values())
                    publish(len(results),'、'.join(pending.values()),'最多 5 节点并行；每个节点顺序采样 3 次')
                    if not pending:break
                    wait(pending,timeout=.3,return_when=FIRST_COMPLETED)
            finally:
                stop.set()
                for future in pending:future.cancel()
        after,_=active_state();unchanged=after==before
        record={'finished_at':dt.datetime.now().astimezone().isoformat(),'started_at':started,'network':network,'expected_ip':EXPECTED,'results':results,
                'before':before,'after':after,'selection_unchanged':unchanged,'reason':reason}
        write_json(t.BASE/'chain-results.json',record)
        directory=t.BASE/'chain-reports';directory.mkdir(exist_ok=True)
        write_json(directory/(dt.datetime.now().strftime('%Y%m%d-%H%M%S')+'.json'),record)
        good=sum(x['chain_delay'] is not None for x in results.values())
        message=(reason+'。' if reason else '')+f'全链路测速完成：{good}/{len(results)} 条获得有效延迟；'+('当前链路未改变。' if unchanged else '检测到外部链路变化。')+'已清理临时测试进程。'
        running=[]
        publish(len(results),'',message)
        return message
