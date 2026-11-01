"""Refresh local subscription sources while retaining the selected live entrance."""
import copy,datetime,fcntl,json,os,re,subprocess,tempfile,urllib.request,urllib.parse
from pathlib import Path
import yaml
import runtime
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
        if not isinstance(doc,dict) or not isinstance(doc.get('proxies'),list) or not doc['proxies']:raise ValueError()
        names=set()
        for n in doc['proxies']:
            if not isinstance(n,dict) or not all(n.get(k) for k in ['name','type','server','port']) or n['name'] in names:raise ValueError()
            names.add(n['name'])
        return doc
    except Exception:raise RuntimeError('订阅下载或解析失败；未改动当前配置') from None

def run(prepared=None):
    os.umask(0o077)
    with open(t.BASE/'latency.lock','a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise RuntimeError('已有测速或订阅更新正在运行')
        before,_=c.active_state()
        if before['exit']!=t.EXIT or before['dialer']!=t.ENTRY:raise RuntimeError('当前链路不符，未修改')
        path=c.CONFIG_DIR/'clash-verge.yaml';original_config=path.read_bytes();conf=yaml.safe_load(original_config)
        registry=runtime.read_json('subscriptions.json').get('sources',[])
        blocked={x.lower() for x in runtime.read_json('node-policy.json').get('blocked_providers',[])}
        if not registry:
            registry=[{'name':name,'url':p.get('url')} for name,p in conf.get('proxy-providers',{}).items() if p.get('type')=='http']
        sources=[x for x in registry if x.get('name','').lower() not in blocked]
        if not sources:raise RuntimeError('没有可更新的订阅；请按 README 设置本机 subscriptions.json')
        if len({x['name'] for x in sources})!=len(sources):raise RuntimeError('订阅名称重复')
        old_nodes,_=c.load_nodes();pin=copy.deepcopy(old_nodes.get(before['entry']))
        if not pin:raise RuntimeError('无法保留当前入口；未修改')
        updates={};definitions={};mapping={};dns={};excluded=runtime.read_json('node-policy.json').get('excluded_nodes',{})
        for source in sources:
            name=source['name']
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,60}',name):raise RuntimeError('订阅名称请使用英文字母、数字或短横线')
            doc=prepared[name] if prepared and name in prepared else fetch(source['url'])
            cache=c.CONFIG_DIR/'providers/linkbox'/(name+'.yaml')
            updates[cache]=dump(doc)
            bad=list(excluded.get(name,[]))+list(excluded.get('*',[]))+[pin['name']]
            pattern=NOTICE.pattern+'|'+('|'.join('^'+re.escape(n)+'$' for n in bad))
            definitions[name]={'type':'http','url':source['url'],'path':str(cache),'interval':86400,'health-check':{'enable':False},'exclude-filter':pattern}
            for n in doc['proxies']:mapping[n['name']]=name
            for k,v in doc.get('dns',{}).get('nameserver-policy',{}).items():
                if not k.startswith(('geosite:','rule-set:')):dns[k]=v
        managed={'providers':definitions,'pin':pin,'dns':dns}
        updated=copy.deepcopy(conf);updated.setdefault('proxy-providers',{}).update(definitions)
        updated['proxies']=[n for n in updated.get('proxies',[]) if n['name']!=pin['name']]+[pin]
        group=next((g for g in updated.get('proxy-groups',[]) if g['name']==t.ENTRY),None)
        if group is None:raise RuntimeError('缺少中转入口组')
        group['proxies']=[pin['name']];group['use']=list(definitions)
        for k in ['include-all','include-all-proxies','include-all-providers']:group.pop(k,None)
        updated.setdefault('dns',{}).setdefault('nameserver-policy',{}).update(dns)
        updated['dns'].setdefault('proxy-server-nameserver-policy',{}).update(dns)
        # Persist the same transformation when Clash Verge regenerates its active profile.
        script=c.CONFIG_DIR/'profiles/Script.js';existing=script.read_text() if script.exists() else 'function main(config) { return config; }'
        wrapper='\n'+MARK+'\nconst linkboxPreviousMain=main;\nmain=function(config,profileName){const r=linkboxPreviousMain(config,profileName);const m='+json.dumps(managed,ensure_ascii=False)+';r["proxy-providers"]={...(r["proxy-providers"]||{}),...m.providers};r.proxies=(r.proxies||[]).filter(p=>p.name!==m.pin.name);r.proxies.push(m.pin);const g=(r["proxy-groups"]||[]).find(g=>g.name==="中转入口");if(g){g.proxies=[m.pin.name];g.use=Object.keys(m.providers);delete g["include-all"];delete g["include-all-proxies"];delete g["include-all-providers"];}r.dns=r.dns||{};r.dns["nameserver-policy"]={...(r.dns["nameserver-policy"]||{}),...m.dns};r.dns["proxy-server-nameserver-policy"]={...(r.dns["proxy-server-nameserver-policy"]||{}),...m.dns};return r;};\n'
        updates[script]=(existing.split(MARK)[0].rstrip()+wrapper).encode();updates[path]=dump(updated)
        policy=runtime.read_json('node-policy.json');policy.setdefault('node_providers',{}).update(mapping);policy['pinned_entry']=pin['name'];updates[runtime.BASE/'node-policy.json']=json.dumps(policy,ensure_ascii=False,indent=2).encode()
        originals={p:p.read_bytes() if p.exists() else None for p in updates}
        # Validation uses isolated copies of provider caches; no live files are changed.
        with tempfile.TemporaryDirectory(prefix='linkbox-update-',dir=c.CONFIG_DIR) as folder:
            folder=Path(folder);check=copy.deepcopy(updated)
            for i,(name,definition) in enumerate(definitions.items()):
                q=folder/(str(i)+'.yaml');q.write_bytes(updates[Path(definition['path'])]);check['proxy-providers'][name]={**definition,'type':'file','path':str(q)};check['proxy-providers'][name].pop('url',None)
            f=folder/'config.yaml';f.write_bytes(dump(check))
            result=subprocess.run([c.CORE,'-t','-d',str(c.CONFIG_DIR),'-f',str(f)],capture_output=True,timeout=30)
            if result.returncode:raise RuntimeError('配置校验失败；未改动当前代理')
        if c.active_state()[0]!=before or any((p.read_bytes() if p.exists() else None)!=data for p,data in originals.items()):raise RuntimeError('配置或节点已被其他操作改变，已取消更新')
        backup=runtime.BASE/'backups'/('update-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'));backup.mkdir(parents=True)
        for i,(p,data) in enumerate(originals.items()):
            if data is not None:(backup/(str(i)+'-'+p.name)).write_bytes(data)
        written=[]
        try:
            for p,data in updates.items():atomic(p,data);written.append(p)
            # Service-mode cores cannot read user-owned paths. Inline provider
            # snapshots for this reload; persistent HTTP definitions stay on disk.
            live=copy.deepcopy(updated)
            for name,definition in live.get('proxy-providers',{}).items():
                source_path=definition.get('path')
                if source_path:
                    q=Path(source_path);q=q if q.is_absolute() else c.CONFIG_DIR/q
                    doc=yaml.safe_load(q.read_bytes())
                    definition.pop('path',None);definition.pop('url',None)
                    definition['type']='inline';definition['payload']=compact(doc['proxies'])
            t.api('PUT','/configs?force=false',{'payload':dump(live).decode()})
        except Exception:
            for p in reversed(written):
                if originals[p] is None:p.unlink(missing_ok=True)
                else:atomic(p,originals[p])
            raise RuntimeError('更新未确认；文件已回退，请刷新状态核对。未切换节点或关闭连接。') from None
        if c.active_state()[0]!=before:raise RuntimeError('更新后检测到外部选择变化，请核对；未继续修改')
        return {'message':'已更新 '+ '、'.join(definitions)+'；筛选规则和当前节点保持不变。'}
