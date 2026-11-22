'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),https=require('node:https'),net=require('node:net');
const {execFile,spawn}=require('node:child_process'),{promisify,isDeepStrictEqual}=require('node:util'),exec=promisify(execFile),YAML=require('yaml'),{HttpsProxyAgent}=require('https-proxy-agent');
const {benchmarkSettings,expectedIP,settingChanges}=require('./preferences.cjs');
const {sameIP}=require('./ip-address.js');
const {selectionOwners}=require('./reconcile.cjs');
const {Clash, ENTRY, EXIT, parseYAML, readFile}=require('./clash.cjs');
const EXPECTED='203.0.113.10',TRACE='https://www.cloudflare.com/cdn-cgi/trace';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function jsonRead(p,fallback={}){try{return JSON.parse(await fs.readFile(p,'utf8'));}catch{return fallback;}}
async function writeJSON(p,v){await fs.mkdir(path.dirname(p),{recursive:true});const tmp=p+'.tmp';await fs.writeFile(tmp,JSON.stringify(v,null,2),{mode:0o600});await fs.rename(tmp,p);}
function safeError(e){return String(e.message||e).replace(/https?:\/\/[^\s]+/g,'[网络地址]').slice(0,250);}
function isolatedConfig(entry,exit,port,iface,kind='chain',dnsPolicy={}){
 if(entry['dialer-proxy'])throw Error('该节点自带链式上游，暂不支持隔离测速');
 const a=structuredClone(entry),b=structuredClone(exit);a.name='TEST_ENTRY';a['interface-name']=iface;delete a['routing-mark'];b.name='TEST_EXIT';b['dialer-proxy']='TEST_ENTRY';delete b['interface-name'];delete b['routing-mark'];
 return {'mixed-port':port,'bind-address':'127.0.0.1','allow-lan':false,mode:'rule','log-level':'silent',ipv6:false,'interface-name':iface,'external-controller':'','tun':{enable:false},'find-process-mode':'off',profile:{'store-selected':false,'store-fake-ip':false},dns:{enable:true,ipv6:false,'enhanced-mode':'normal','default-nameserver':['223.5.5.5','119.29.29.29'],nameserver:['https://dns.alidns.com/dns-query'],'proxy-server-nameserver':['https://dns.alidns.com/dns-query'],'nameserver-policy':dnsPolicy,'proxy-server-nameserver-policy':dnsPolicy},proxies:kind==='chain'?[a,b]:[a],'proxy-groups':[],rules:[...(kind==='chain'?['DOMAIN,www.gstatic.com,TEST_ENTRY']:[]),'MATCH,'+(kind==='chain'?'TEST_EXIT':'TEST_ENTRY')]};
}
function autoCandidate(results,current,metric){
 if(!Object.hasOwn(results,current))return null;
 const key=metric==='entrance'?'entranceDelay':'chainDelay';
 const valid=value=>Number.isInteger(value)&&value>0;
 const best=Object.entries(results).filter(([name,r])=>name!==current&&valid(r.chainDelay)&&valid(r[key])).sort(([a,x],[b,y])=>x[key]-y[key]||(a<b?-1:1))[0];
 if(!best)return null;
 const currentRow=results[current],baseline=currentRow[key];
 return !valid(currentRow.chainDelay)||(valid(baseline)&&baseline-best[1][key]>=Math.max(20,baseline*.10))?best[0]:null;
}
function signature(s){return JSON.stringify([s.mode,s.tun,s.entry,s.exit,s.dialer,[...new Set(s.live)].sort()]);}
function providerNodes(response){
 const providers=response?.providers;
 return new Map(Object.entries(providers&&typeof providers==='object'&&!Array.isArray(providers)?providers:{})
  .filter(([,provider])=>Array.isArray(provider?.proxies))
  .map(([owner,provider])=>[owner,provider.proxies.filter(node=>typeof node?.name==='string'&&node.name)]));
}
function ipv6Assessment(addresses,probes){
 if(probes.some(x=>x.connected))return {status:'warn',detail:'存在 IPv6 通路，需核实出口；连接成功本身不等于泄漏'};
 if(!Array.isArray(addresses)||probes.some(x=>x.connected!==false))return {status:'warn',detail:'结果不完整，IPv6 未验证'};
 if(addresses.length)return {status:'warn',detail:'网卡有公网 IPv6 地址，探测未连通，仍需核对'};
 return {status:'ok',detail:'无公网 IPv6 地址，两个公网目标均连接失败；本轮未发现绕过通路'};
}
function assessClaude(rows,connections,expectedProxyIP,expectedIP=EXPECTED){
 const matched=[],other=[];
 for(const row of rows){const found=connections.filter(x=>String(x.metadata?.sourcePort)===String(row.LocalPort)&&(!x.metadata.sourceIP||x.metadata.sourceIP===row.LocalAddress));
  if(found.length===1)matched.push({pid:row.OwningProcess,host:found[0].metadata.host,chains:found[0].chains||[]});else other.push({pid:row.OwningProcess,remote:row.RemoteAddress,port:row.RemotePort});}
 const good=matched.filter(x=>x.chains.includes(EXIT)).length,bad=matched.some(x=>x.chains.length&&!x.chains.includes(EXIT));
 return {status:bad?'bad':good>0&&good===rows.length&&sameIP(expectedProxyIP,expectedIP)?'ok':'warn',detail:rows.length?`${good}/${rows.length} 条 Claude Code 连接匹配美国静态家宽；${other.length} 条未匹配`:'当前无可核验的 Claude Code 连接，未验证',matched,other};
}
class Backend{
 constructor(dataDir,notify=()=>{}){this.dataDir=dataDir;this.notify=notify;this.settings={};this.clash=new Clash(()=>this.settings,script=>this.powershell(script));this.autoRevision=0;this.pendingSettings=0;this.settingsWrite=Promise.resolve();this.nodePolicy={};this.children=new Set();this.busy=false;this.cancelled=false;this.progress={running:false,results:{}};this.guard=new Set();}
 async init(){
  await fs.mkdir(this.dataDir,{recursive:true});
  const saved=await jsonRead(path.join(this.dataDir,'settings.json'));
  if(saved&&typeof saved==='object'&&!Array.isArray(saved))this.settings=saved;
  this.history=await jsonRead(path.join(this.dataDir,'results.json'),{});
  return this;
 }
 async saveSettings(values){
 const changes=settingChanges(values);
 const connectionChange='configDir' in changes||'corePath' in changes;
 if(this.busy&&connectionChange)throw Error('请等待当前操作完成后再修改连接设置');
 this.autoRevision++;this.pendingSettings++;
 const write=this.settingsWrite.then(async()=>{
  if(this.busy&&connectionChange)throw Error('请等待当前操作完成后再修改连接设置');
  const next={...this.settings,...changes};
  await writeJSON(path.join(this.dataDir,'settings.json'),next);this.settings=next;if(connectionChange)this.clash.resetConnection();
 });
 this.settingsWrite=write.catch(()=>{});try{await write;}finally{this.pendingSettings--;this.autoRevision++;}
 }
 async powershell(script){const encoded=Buffer.from("[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$ErrorActionPreference='Stop';"+script,'utf16le').toString('base64');const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',encoded],{windowsHide:true,timeout:12000,maxBuffer:2e6});return stdout.trim();}
 async state(timeout){
  const override=this.settings.expectedIP;
  this.nodePolicy=await jsonRead(path.join(this.dataDir,'node-policy.json'),{});
  const cfg=await this.clash.config(), configured=cfg.proxies?.find(n=>n.name===EXIT)?.server;
  const {entryPlan}=require('./subscriptions.cjs');
  const [relay,providers,plan]=await Promise.all([
   this.clash.relayState(timeout),this.clash.providers(timeout).catch(()=>({})),
   entryPlan(cfg,this.clash).catch(()=>null),
  ]);
  const owners=this.nodePolicy.selected_nodes==null
   ? new Map(relay.live.map(name=>[name,plan?.get(name)?.owner??null]))
   : selectionOwners(this.nodePolicy.selected_nodes);
  const entryOwners=Object.fromEntries([...owners].filter(([name])=>relay.live.includes(name)));
  const liveRows=new Map();
  for(const [owner,proxies] of providerNodes(providers)){
   for(const node of proxies){
    if(owners.get(node.name)===owner)liveRows.set(node.name,node);
   }
  }
  const nodes=Array.from(owners,([name,owner])=>{
   const result=Object.hasOwn(this.history.results||{},name)?this.history.results[name]:{};
   return {name,providerId:owner,provider:this.nodePolicy.provider_labels?.[owner]||owner||'Clash',
    type:liveRows.get(name)?.type??plan?.get(name)?.node?.type,...(result.owner==null||result.owner===owner?result:{})};
  });
  return {...relay,expectedIP:expectedIP(override,configured),nodes,
   entryOwners,switchable:Object.keys(entryOwners),lastTest:this.history.finishedAt,
   settings:{...benchmarkSettings(this.settings),configDir:this.clash.root,corePath:this.clash.connectionPath('corePath')},
   progress:this.progress};
 }
 assertChain(s){if(s.mode!=='global'||s.exit!==EXIT||s.dialer!==ENTRY)throw Error('请先在 Clash Verge 选择全局 → 美国静态家宽，并启用链式配置。');}
 async switchNode(name,previous){
  if(this.busy)throw Error('请先停止本轮测速或等待当前操作完成');
  this.busy=true;
  try{
   const before=await this.state();
   this.assertChain(before);
   if(before.entry!==previous||!before.switchable.includes(name))throw Error('节点状态已变化，请刷新状态');
   const owner=before.entryOwners[name];
   if(name!==previous)await this.clash.switchEntry(name);
   const after=await this.state();
   if(after.entry!==name||after.exit!==EXIT||after.mode!=='global'||after.dialer!==ENTRY||
    !after.switchable.includes(name)||after.entryOwners[name]!==owner){
    throw Error('切换后的状态待核对，请刷新 Clash 状态');
   }
   const switchWarning = name === previous ? undefined : await this.persistSwitch(name);
   return switchWarning ? {...after, switchWarning} : after;
  }finally{this.busy=false;}
 }

 async persistSwitch(name) {
  try { await this.clash.persistSelection(name, path.join(this.dataDir, 'backups')); }
  catch (error) { return '实时切换成功，但保存选择失败：' + safeError(error); }
 }

 async textRequest(url,port=null,{timeout=12000,max=2e6,signal,accept=[200]}={}){
  const u=new URL(url);if(u.protocol!=='https:')throw Error('只允许 HTTPS');
  return new Promise((resolve,reject)=>{const agent=port?new HttpsProxyAgent('http://127.0.0.1:'+port):undefined;const req=https.get(u,{agent,signal,headers:{'User-Agent':'clash-verge/LinkBox-1.0'}},r=>{let parts=[],size=0;r.on('data',b=>{size+=b.length;if(size>max){req.destroy(Error('响应过大'));return;}parts.push(b)});r.on('error',reject);r.on('end',()=>{if(!accept.includes(r.statusCode))return reject(Error('网络响应 '+r.statusCode));resolve(Buffer.concat(parts).toString())});});const timer=setTimeout(()=>req.destroy(Error('请求超时')),timeout);req.on('error',reject);req.on('close',()=>{clearTimeout(timer);agent?.destroy()});});}
 async trace(port,signal){const text=await this.textRequest(TRACE,port,{signal,timeout:8000});const values=Object.fromEntries(text.split('\n').filter(x=>x.includes('=')).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)]}));if(!net.isIP(values.ip))throw Error('未取得有效出口');return {ip:values.ip,country:values.loc};}
 async ipInfo(){const s=await this.state();const v=JSON.parse(await this.textRequest('https://ipwho.is/',s.mixedPort));if(v.success!==true)throw Error('IP 属性查询失败');return {ip:v.ip,country:v.country,region:v.region,city:v.city,asn:v.connection?.asn,isp:v.connection?.isp,updatedAt:new Date().toISOString()};}
 async loadNodes({expectedIP:override}=this.settings){
  const config=await this.clash.config();
  const selection=(await jsonRead(path.join(this.dataDir,'node-policy.json'))).selected_nodes;
  const {entryPlan}=require('./subscriptions.cjs');
  const owners=selectionOwners(selection);
  const nodes=new Map();
  if(selection==null){
   const plan=await entryPlan(config,this.clash).catch(()=>new Map());
   for(const [name,{node}] of plan)if(node)nodes.set(name,node);
  }
  const providers=config['proxy-providers']||{};
  for(const owner of new Set(owners.values())){
   const provider=Object.hasOwn(providers,owner)?providers[owner]??{}:{};
   let list=provider.payload;
   if(provider.path){
    try{list=parseYAML((await readFile(this.clash.providerFile(provider.path)))?.toString() || '')?.proxies;}
    catch{continue;}
   }
   if(!Array.isArray(list))continue;
   for(const node of list){
    if(owners.get(node?.name)===owner&&!nodes.has(node.name))nodes.set(node.name,node);
   }
  }
  const exit=config.proxies?.find(n=>n.name===EXIT);
  const expected=expectedIP(override,exit?.server);
  const dnsPolicy=Object.fromEntries(Object.entries(config.dns?.['proxy-server-nameserver-policy']||{}).filter(([k])=>!k.startsWith('geosite:')&&!k.startsWith('rule-set:')));
  if(!exit||!net.isIP(expected))throw Error('找不到固定出口配置或有效的预期出口 IP');
  if(exit['dialer-proxy']!==ENTRY)throw Error('固定出口的链式上游已变化，未开始测试');
  return {nodes,exit,config,expectedIP:expected,dnsPolicy};
 }
 async network(){if(process.platform!=='win32')throw Error('完整链路测速需在 Windows 实机运行');
 const raw=await this.powershell("$a=@(Get-NetAdapter -Physical | Where-Object Status -eq 'Up');$r=@(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | Where-Object {$a.ifIndex -contains $_.ifIndex} | ForEach-Object {$i=Get-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $_.ifIndex;[pscustomobject]@{name=$_.InterfaceAlias;index=$_.ifIndex;gateway=$_.NextHop;metric=($_.RouteMetric+$i.InterfaceMetric)}} | Sort-Object metric);if(!$r.Count){throw 'No physical IPv4 route'};$n=$r[0];$ip=@(Get-NetIPAddress -InterfaceIndex $n.index -AddressFamily IPv4 | Where-Object AddressState -eq 'Preferred' | Select-Object -ExpandProperty IPAddress);[pscustomobject]@{name=$n.name;index=$n.index;gateway=$n.gateway;addresses=$ip} | ConvertTo-Json -Compress");return JSON.parse(raw);}
 async freePort(){const s=net.createServer();await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,'127.0.0.1',resolve)});const port=s.address().port;await new Promise(r=>s.close(r));return port;}
 async stopChild(child){if(child.exitCode!==null)return;child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),pause(1800)]);if(child.exitCode===null)child.kill('SIGKILL');}
 async testNode(node,exit,network,core,kind,signal,probe){const folder=await fs.mkdtemp(path.join(this.dataDir,'probe-'));let child,entranceDelay=null;const samples=[];try{
 const port=await this.freePort(),config=isolatedConfig(node,exit,port,network.name,kind,probe.dnsPolicy);const file=path.join(folder,'config.yaml');await fs.writeFile(file,YAML.stringify(config),{mode:0o600});
 child=spawn(core,['-d',folder,'-f',file],{windowsHide:true,stdio:'ignore'});this.children.add(child);let spawnError;child.once('error',e=>spawnError=e);
 let ready=false;for(let i=0;i<40;i++){if(signal.aborted)throw Error('已停止');if(spawnError||child.exitCode!==null)throw Error('隔离内核无法启动');ready=await new Promise(r=>{const s=net.connect(port,'127.0.0.1');s.setTimeout(100);s.once('connect',()=>{s.destroy();r(true)});s.once('error',()=>r(false));s.once('timeout',()=>{s.destroy();r(false)});});if(ready)break;await pause(100);}if(!ready)throw Error('临时端口未就绪');
 // Validate the temporary listener belongs to exactly our child before sending a probe.
 const owner=await this.powershell(`@(Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object -ExpandProperty OwningProcess -Unique) | ConvertTo-Json -Compress`);if(!owner||[JSON.parse(owner)].flat().length!==1||JSON.parse(owner)!==child.pid&&JSON.parse(owner)[0]!==child.pid)throw Error('无法确认临时端口归属');
 if(kind==='chain'){const started=performance.now();try{await this.textRequest('https://www.gstatic.com/generate_204',port,{signal,timeout:8000,accept:[204]});entranceDelay=Math.round(performance.now()-started)}catch{}}
 for(let i=0;i<(kind==='chain'?3:1);i++){if(signal.aborted)throw Error('已停止');const start=performance.now();try{const res=await this.trace(port,signal);if(kind==='chain'&&!sameIP(res.ip,probe.expectedIP))throw Error('出口不符：'+res.ip);samples.push({ms:Math.round(performance.now()-start),ip:res.ip});}catch(e){if(!samples.length)throw e;}await pause(100);}
 if(kind==='chain'&&samples.length<2)throw Error('成功样本不足两次');const times=samples.map(x=>x.ms).sort((a,b)=>a-b);return {delay:Math.round((times[Math.floor((times.length-1)/2)]+times[Math.floor(times.length/2)])/2),samples,status:'done',kind,...(kind==='chain'?{entranceDelay}:{})};
 }catch(e){return {delay:null,status:'failed',kind,error:safeError(e),...(kind==='chain'?{entranceDelay}:{})}}finally{if(child){await this.stopChild(child);this.children.delete(child)}await fs.rm(folder,{recursive:true,force:true}).catch(()=>{});}}
 async benchmark(kind='chain',mayAutoSwitch=null){
 if(this.busy)throw Error('已有操作正在运行');if(!['chain','entrance'].includes(kind))throw Error('无效测速类型');this.busy=true;const abort=new AbortController();this.abort=abort;let reason='';const settings=this.settings,options=benchmarkSettings(settings),revision=this.autoRevision,settingsStable=!this.pendingSettings;
 try{
 const historyFile=path.join(this.dataDir,'results.json');
 this.history={...this.history,latestResults:{}};
 await writeJSON(historyFile,this.history);
 const before=await this.state();this.assertChain(before);
 const network=await this.network(),probe=await this.loadNodes(settings),{nodes,exit}=probe,core=await this.clash.corePath();
 this.progress={running:true,kind,total:before.nodes.length,completed:0,results:{},active:[]};const emit=()=>this.notify('progress',this.progress);emit();
 let next=0;
 const unchanged=async()=>signature(await this.state())===signature(before)&&
  JSON.stringify(await this.network())===JSON.stringify(network);
 let pendingGuard;
 const guard=setInterval(()=>{
  if(pendingGuard||abort.signal.aborted)return;
  pendingGuard=unchanged().then(stable=>{
   if(!stable){reason='网络或节点已变化，本轮停止；未调整代理';abort.abort();}
  }).catch(()=>{
   reason='无法继续确认当前网络，本轮停止';abort.abort();
  }).finally(()=>{pendingGuard=null;});
 },2500);
 this.guard.add(guard);
 const worker=async()=>{
  while(!abort.signal.aborted){
   const row=before.nodes[next++];
   if(!row)break;
   this.progress.active.push(row.name);emit();
   try{
    let result;
    try{
     const node=nodes.get(row.name);
     if(!node)throw Error('订阅缓存缺少该节点，请先更新订阅');
     result=await this.testNode(node,exit,network,core,kind,abort.signal,probe);
    }catch(error){
     result={delay:null,status:'failed',kind,error:safeError(error)};
    }
    if(abort.signal.aborted)continue;
    if(!await unchanged()){
     reason='网络或节点变化，已丢弃本次结果';
     abort.abort();
    }
    if(!abort.signal.aborted){
     const owner=row.providerId;
     Object.defineProperty(this.progress.results,row.name,{enumerable:true,configurable:true,value:{
      chainDelay:null,entranceDelay:null,...result,owner,[kind==='chain'?'chainDelay':'entranceDelay']:result.delay,
     }});
     this.progress.completed++;
    }
   }finally{
    this.progress.active=this.progress.active.filter(x=>x!==row.name);emit();
   }
  }
 };
 try{
  const settled=await Promise.allSettled(Array.from({length:options.concurrency},()=>worker().catch(error=>{
   abort.abort();
   throw error;
  })));
  const failure=settled.find(result=>result.status==='rejected');
  if(failure)throw failure.reason;
 }finally{
  clearInterval(guard);this.guard.delete(guard);
  await pendingGuard;
 }
 const completedHistory={finishedAt:new Date().toISOString(),kind,reason:reason||(abort.signal.aborted?'手动停止':''),
  latestResults:this.progress.results,results:{...this.history.results,...this.progress.results}};
 await writeJSON(historyFile,completedHistory);
 this.history=completedHistory;
 const authorized=()=>mayAutoSwitch?.()&&settingsStable&&!this.pendingSettings&&options.autoRelay&&this.settings.autoRelay===true&&benchmarkSettings(this.settings).metric===options.metric&&this.settings.hourly!==false&&revision===this.autoRevision&&!abort.signal.aborted;
 if(kind==='chain'&&!this.history.reason&&this.progress.completed===this.progress.total&&authorized()){
  const target=autoCandidate(this.progress.results,before.entry,options.metric);
  if(target){
   const currentNetwork=await this.network(),current=await this.state();
   const unchanged=authorized()&&signature(current)===signature(before)&&
    JSON.stringify(currentNetwork)===JSON.stringify(network);
   const fresh=await this.loadNodes().catch(()=>null);
   const sameRouting=fresh?.nodes.has(target)&&isDeepStrictEqual(
    [nodes.get(before.entry),nodes.get(target),exit,probe.dnsPolicy,probe.expectedIP],
    [fresh.nodes.get(before.entry),fresh.nodes.get(target),fresh.exit,fresh.dnsPolicy,fresh.expectedIP]);
   if(sameRouting&&unchanged&&current.live.includes(target)){
    const owner=before.nodes.find(row=>row.name===target)?.providerId;
    if(!current.switchable.includes(target)||current.entryOwners[target]!==owner)throw Error('节点归属已变化，请先更新订阅');
    if(!authorized())return this.history;
    await this.clash.switchEntry(target);
    const after=await this.state();
    if(after.entry!==target||after.mode!==before.mode||after.tun!==before.tun||
     after.exit!==before.exit||after.dialer!==before.dialer||
     !after.switchable.includes(target)||after.entryOwners[target]!==owner)throw Error('自动切换后的状态待核对，请刷新 Clash 状态');
    const switchWarning = await this.persistSwitch(target);
    return {...this.history,switchedTo:target,...(switchWarning ? {switchWarning} : {})};
   }
  }
 }
 return this.history;
 }finally{abort.abort();this.busy=false;this.abort=null;this.progress.running=false;this.progress.active=[];this.notify('progress',this.progress);}}
 cancel(){this.abort?.abort();}
 async updateSubscriptions(){return require('./subscriptions.cjs').run(this);}
 async ipv6Probe(host){return new Promise(resolve=>{const s=net.connect({host,port:443,family:6});const finish=v=>{s.destroy();resolve(v)};s.setTimeout(4000);s.once('connect',()=>finish({connected:true,local:s.localAddress}));s.once('error',e=>finish({connected:false,reason:e.code}));s.once('timeout',()=>finish({connected:false,reason:'timeout'}));});}
 async networkCheck(){const interfacesBefore=JSON.stringify(os.networkInterfaces());const safe=async fn=>{try{return await fn()}catch(e){return {error:safeError(e)}}};const timeout=4000,s=await this.state(timeout),expected=s.expectedIP;
 const [proxy,tun,v6a,v6b,claudeRaw,connectionSnapshot]=await Promise.all([safe(()=>this.trace(s.mixedPort)),safe(()=>this.trace()),this.ipv6Probe('2606:4700:4700::1111'),this.ipv6Probe('2001:4860:4860::8888'),safe(async()=>{
 if(process.platform!=='win32')throw Error('Claude Code 进程核验需要 Windows');
 const raw=await this.powershell("$p=@(Get-Process -Name claude -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id);$c=@(Get-NetTCPConnection -State Established | Where-Object {$p -contains $_.OwningProcess} | Select-Object OwningProcess,LocalAddress,LocalPort,RemoteAddress,RemotePort);[pscustomobject]@{processCount=$p.Count;connections=$c} | ConvertTo-Json -Depth 5 -Compress");return JSON.parse(raw);
 }),safe(()=>this.clash.connections(timeout))]);
 const addresses=Object.values(os.networkInterfaces()).flat().filter(x=>x&&x.family==='IPv6'&&!x.internal&&!/^(fe[89ab]|f[cd]|::)/i.test(x.address)).map(x=>x.address);
 const claude=claudeRaw.error||connectionSnapshot.error?{status:'warn',detail:'Claude Code 连接未验证：'+(claudeRaw.error||connectionSnapshot.error)}:assessClaude(claudeRaw.connections||[],connectionSnapshot.connections||[],proxy.ip,expected);
 let stable=false;try{stable=signature(await this.state(timeout))===signature(s)&&JSON.stringify(os.networkInterfaces())===interfacesBefore;}catch{}
 const result={time:new Date().toISOString(),expected,stable,state:{mode:s.mode,tun:s.tun,ipv6:s.ipv6,entry:s.entry,exit:s.exit},proxy,tun,ipv6:{...ipv6Assessment(addresses,[v6a,v6b]),addresses,probes:[v6a,v6b]},claude};return result;}
 async shutdown(){this.cancel();for(const t of this.guard)clearInterval(t);await Promise.all([...this.children].map(c=>this.stopChild(c)));}
}
module.exports={Backend,autoCandidate,isolatedConfig,signature,providerNodes,ipv6Assessment,assessClaude,EXPECTED,ENTRY,EXIT,writeJSON,safeError};
