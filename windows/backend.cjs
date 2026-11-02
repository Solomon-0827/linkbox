'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http'),https=require('node:https'),net=require('node:net');
const {execFile,spawn}=require('node:child_process'),{promisify}=require('node:util'),exec=promisify(execFile),YAML=require('yaml'),{HttpsProxyAgent}=require('https-proxy-agent');
const ENTRY='中转入口',EXIT='美国静态家宽',EXPECTED='203.0.113.10',TRACE='https://www.cloudflare.com/cdn-cgi/trace';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function jsonRead(p,fallback={}){try{return JSON.parse(await fs.readFile(p,'utf8'));}catch{return fallback;}}
async function writeJSON(p,v){await fs.mkdir(path.dirname(p),{recursive:true});const tmp=p+'.tmp';await fs.writeFile(tmp,JSON.stringify(v,null,2),{mode:0o600});await fs.rename(tmp,p);}
function safeError(e){return String(e.message||e).replace(/https?:\/\/[^\s]+/g,'[网络地址]').slice(0,250);}
function isolatedConfig(entry,exit,port,iface,kind='chain',dnsPolicy={}){
 if(entry['dialer-proxy'])throw Error('该节点自带链式上游，暂不支持隔离测速');
 const a=structuredClone(entry),b=structuredClone(exit);a.name='TEST_ENTRY';a['interface-name']=iface;delete a['routing-mark'];b.name='TEST_EXIT';b['dialer-proxy']='TEST_ENTRY';delete b['interface-name'];delete b['routing-mark'];
 return {'mixed-port':port,'bind-address':'127.0.0.1','allow-lan':false,mode:'rule','log-level':'silent',ipv6:false,'interface-name':iface,'external-controller':'','tun':{enable:false},'find-process-mode':'off',profile:{'store-selected':false,'store-fake-ip':false},dns:{enable:true,ipv6:false,'enhanced-mode':'normal','default-nameserver':['223.5.5.5','119.29.29.29'],nameserver:['https://dns.alidns.com/dns-query'],'proxy-server-nameserver':['https://dns.alidns.com/dns-query'],'nameserver-policy':dnsPolicy,'proxy-server-nameserver-policy':dnsPolicy},proxies:kind==='chain'?[a,b]:[a],'proxy-groups':[],rules:[...(kind==='chain'?['DOMAIN,www.gstatic.com,TEST_ENTRY']:[]),'MATCH,'+(kind==='chain'?'TEST_EXIT':'TEST_ENTRY')]};
}
function nodeProvider(policy,name,fallback='本地节点'){return Object.hasOwn(policy.node_providers||{},name)?policy.node_providers[name]:fallback;}
function nodeAllowed(policy,name,provider){provider=nodeProvider(policy,name,provider);if(name===policy.pinned_entry)return true;if(policy.selected_nodes)return (policy.selected_nodes[provider]||[]).includes(name);return !(policy.blocked_providers||[]).some(p=>p.toLowerCase()===provider.toLowerCase())&&!(policy.excluded_nodes?.[provider]||[]).includes(name)&&!(policy.excluded_nodes?.['*']||[]).includes(name);}
function signature(s){return JSON.stringify([s.mode,s.tun,s.entry,s.exit,s.dialer]);}
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
 return {status:bad?'bad':good>0&&good===rows.length&&expectedProxyIP===expectedIP?'ok':'warn',detail:rows.length?`${good}/${rows.length} 条 Claude Code 连接匹配美国静态家宽；${other.length} 条未匹配`:'当前无可核验的 Claude Code 连接，未验证',matched,other};
}
class Backend{
 constructor(dataDir,notify=()=>{}){this.dataDir=dataDir;this.notify=notify;this.settings={};this.expectedIP='';this.nodePolicy={};this.dnsPolicy={};this.children=new Set();this.busy=false;this.cancelled=false;this.progress={running:false,results:{}};this.guard=new Set();}
 async init(){await fs.mkdir(this.dataDir,{recursive:true});this.settings=await jsonRead(path.join(this.dataDir,'settings.json'),{hourly:true});this.history=await jsonRead(path.join(this.dataDir,'results.json'),{});return this;}
 async saveSettings(values){if(this.busy&&('configDir' in values||'corePath' in values))throw Error('请等待当前操作完成后再修改连接设置');for(const key of ['configDir','corePath','hourly'])if(key in values)this.settings[key]=values[key];await writeJSON(path.join(this.dataDir,'settings.json'),this.settings);this.endpoint=null;}
 async powershell(script){const encoded=Buffer.from("[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$ErrorActionPreference='Stop';"+script,'utf16le').toString('base64');const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',encoded],{windowsHide:true,timeout:12000,maxBuffer:2e6});return stdout.trim();}
 async config(){
 const roots=this.settings.configDir?[this.settings.configDir]:process.platform==='win32'?[path.join(process.env.APPDATA||'','io.github.clash-verge-rev.clash-verge-rev'),path.join(process.env.LOCALAPPDATA||'','io.github.clash-verge-rev.clash-verge-rev')]:[path.join(os.homedir(),'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev')];
 for(const root of roots)for(const name of ['clash-verge.yaml','config.yaml'])try{const c=YAML.parse(await fs.readFile(path.join(root,name),'utf8'));if(c&&Array.isArray(c.proxies)){this.root=root;this.configFile=path.join(root,name);return c;}}catch{}
 throw Error('未找到 Clash Verge 配置。请先启用链式配置，或在设置中选择配置目录。');}
 async discover(){const c=await this.config();const endpoints=[];
 // Clash Verge service uses an owner-scoped endpoint, overriding the sidecar path in YAML.
 if(process.platform==='darwin')endpoints.push({socketPath:`/var/run/clash-verge-service/users/${process.getuid()}/verge-mihomo.sock`});
 if(process.platform==='win32')try{const sid=await this.powershell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');if(/^S-1-[0-9-]+$/.test(sid)){const key=require('node:crypto').createHash('sha256').update(sid).digest('hex');for(const prefix of ['verge-mihomo-production-','verge-mihomo-sidecar-release-'])endpoints.push({socketPath:'\\\\.\\pipe\\'+prefix+key});}}catch{}

 if(process.platform==='win32'&&typeof c['external-controller-pipe']==='string'&&c['external-controller-pipe'].startsWith('\\\\.\\pipe\\'))endpoints.push({socketPath:c['external-controller-pipe']});
 if(process.platform==='darwin'&&c['external-controller-unix'])endpoints.push({socketPath:c['external-controller-unix']});
 if(c['external-controller']){const u=new URL('http://'+c['external-controller']);if(['127.0.0.1','localhost','0.0.0.0','[::1]','[::]'].includes(u.hostname))endpoints.push({hostname:'127.0.0.1',port:Number(u.port),secret:c.secret});}
 for(const e of endpoints)try{await this.request(e,'GET','/version');this.endpoint=e;return;}catch{}
 throw Error('无法连接 Clash Verge 本机控制接口。请确认 Clash Verge 正在运行；无需开启局域网控制。');}
 request(endpoint,method,route,body,timeout=6000){return new Promise((resolve,reject)=>{
  const {secret,...opts}=endpoint;const payload=body===undefined?null:JSON.stringify(body);
  const req=http.request({...opts,method,path:route,headers:{...(secret?{Authorization:'Bearer '+secret}:{}),...(payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{})}},r=>{let chunks=[],size=0;r.on('data',x=>{size+=x.length;if(size>12e6){req.destroy(Error('响应过大'));return;}chunks.push(x)});r.on('error',reject);r.on('end',()=>{if(r.statusCode>=300)return reject(Error('Clash 控制接口返回 '+r.statusCode));try{resolve(chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{});}catch{reject(Error('Clash 返回无效数据'));}})});
  const timer=setTimeout(()=>req.destroy(Error('Clash 控制接口超时')),timeout);req.on('close',()=>clearTimeout(timer));req.on('error',reject);if(payload)req.write(payload);req.end();});}
 async api(method,route,body,timeout){
  if(method!=='GET'&&!(method==='PUT'&&(route==='/proxies/'+encodeURIComponent(ENTRY)||/^\/providers\/proxies\/[^/?]+$/.test(route))))throw Error('不允许该控制操作');
  if(!this.endpoint)await this.discover();return this.request(this.endpoint,method,route,body,timeout);}
 async state(){this.nodePolicy=await jsonRead(path.join(this.dataDir,'node-policy.json'),{});const cfg=await this.config();const configured=cfg.proxies.find(n=>n.name===EXIT)?.server;this.expectedIP=this.settings.expectedIP||(net.isIP(configured||'')?configured:'');const [c,p,providers]=await Promise.all([this.api('GET','/configs'),this.api('GET','/proxies'),this.api('GET','/providers/proxies')]);const all=p.proxies||{},g=all[ENTRY]||{},lookup={};
 for(const [provider,v]of Object.entries(providers.providers||{}))for(const n of v.proxies||[])lookup[n.name]={...n,provider};
 for(const [name,v]of Object.entries(all))lookup[name]={...lookup[name],...v};
 return {expectedIP:this.expectedIP,mode:c.mode,tun:!!c.tun?.enable,ipv6:c.ipv6,mixedPort:c['mixed-port']||7897,entry:g.now,exit:all.GLOBAL?.now,dialer:all[EXIT]?.['dialer-proxy'],nodes:(g.all||[]).filter(x=>!(/剩余流量|重置剩余|套餐到期|官网续费|务必加Q群/.test(x))).map(name=>({name,provider:nodeProvider(this.nodePolicy,name,lookup[name]?.provider||'本地节点'),type:lookup[name]?.type,...this.history.results?.[name]})).filter(n=>n.name===g.now||nodeAllowed(this.nodePolicy,n.name,n.provider)).map(n=>({...n,providerId:n.provider,provider:this.nodePolicy.provider_labels?.[n.provider]||n.provider})),lastTest:this.history.finishedAt,settings:{hourly:this.settings.hourly!==false,configDir:this.root,corePath:this.settings.corePath||''},progress:this.progress};}
 assertChain(s){if(s.mode!=='global'||s.exit!==EXIT||s.dialer!==ENTRY)throw Error('请先在 Clash Verge 选择全局 → 美国静态家宽，并启用链式配置。');}
 async switchNode(name,previous){if(this.busy)throw Error('请先停止本轮测速或等待当前操作完成');this.busy=true;try{const before=await this.state();this.assertChain(before);if(before.entry!==previous||!before.nodes.some(x=>x.name===name))throw Error('节点状态已变化，请刷新状态');if(name!==previous)await this.api('PUT','/proxies/'+encodeURIComponent(ENTRY),{name});const after=await this.state();if(after.entry!==name||after.exit!==EXIT||after.mode!=='global')throw Error('切换后的状态待核对，请刷新；没有继续调整');return after;}finally{this.busy=false;}}

 async textRequest(url,port=null,{timeout=12000,max=2e6,signal,accept=[200]}={}){
  const u=new URL(url);if(u.protocol!=='https:')throw Error('只允许 HTTPS');
  return new Promise((resolve,reject)=>{const agent=port?new HttpsProxyAgent('http://127.0.0.1:'+port):undefined;const req=https.get(u,{agent,signal,headers:{'User-Agent':'clash-verge/LinkBox-1.0'}},r=>{let parts=[],size=0;r.on('data',b=>{size+=b.length;if(size>max){req.destroy(Error('响应过大'));return;}parts.push(b)});r.on('error',reject);r.on('end',()=>{if(!accept.includes(r.statusCode))return reject(Error('网络响应 '+r.statusCode));resolve(Buffer.concat(parts).toString())});});const timer=setTimeout(()=>req.destroy(Error('请求超时')),timeout);req.on('error',reject);req.on('close',()=>{clearTimeout(timer);agent?.destroy()});});}
 async trace(port,signal){const text=await this.textRequest(TRACE,port,{signal,timeout:8000});const values=Object.fromEntries(text.split('\n').filter(x=>x.includes('=')).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)]}));if(!net.isIP(values.ip))throw Error('未取得有效出口');return {ip:values.ip,country:values.loc};}
 async ipInfo(){const s=await this.state();const v=JSON.parse(await this.textRequest('https://ipwho.is/',s.mixedPort));if(v.success!==true)throw Error('IP 属性查询失败');return {ip:v.ip,country:v.country,region:v.region,city:v.city,asn:v.connection?.asn,isp:v.connection?.isp,updatedAt:new Date().toISOString()};}
 async loadNodes(){const c=await this.config(),nodes=new Map((c.proxies||[]).map(n=>[n.name,n]));
 for(const p of Object.values(c['proxy-providers']||{})){let list=p.payload||[];if(p.path)try{const file=path.isAbsolute(p.path)?p.path:path.join(this.root,p.path);list=YAML.parse(await fs.readFile(file,'utf8')).proxies||[];}catch{}for(const n of list)if(!nodes.has(n.name))nodes.set(n.name,n);}
 const exit=nodes.get(EXIT);this.expectedIP=this.settings.expectedIP||(net.isIP(exit?.server||'')?exit.server:'');this.dnsPolicy=Object.fromEntries(Object.entries(c.dns?.['proxy-server-nameserver-policy']||{}).filter(([k])=>!k.startsWith('geosite:')&&!k.startsWith('rule-set:')));if(!exit||!this.expectedIP)throw Error('未找到预期美国静态出口凭据');return {nodes,exit,config:c};}
 async corePath(){if(this.settings.corePath){await fs.access(this.settings.corePath);return this.settings.corePath;}if(process.platform==='darwin')return '/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo';
 try{const raw=await this.powershell("@(Get-CimInstance Win32_Process | Where-Object {$_.Name -match '^(verge-mihomo|mihomo|clash-meta)(-alpha)?\\.exe$'} | Select-Object -ExpandProperty ExecutablePath) | ConvertTo-Json -Compress");const found=JSON.parse(raw||'[]');for(const p of [found].flat())if(p){await fs.access(p);return p;}}catch{}
 for(const base of [process.env.ProgramFiles,process.env.LOCALAPPDATA&&path.join(process.env.LOCALAPPDATA,'Programs')].filter(Boolean))for(const suffix of ['Clash Verge/verge-mihomo.exe','Clash Verge/resources/verge-mihomo.exe']){const p=path.join(base,suffix);try{await fs.access(p);return p;}catch{}}
 throw Error('未找到 Mihomo 内核，请在设置中选择 Clash Verge 自带的 verge-mihomo.exe');}
 async network(){if(process.platform!=='win32')throw Error('完整链路测速需在 Windows 实机运行');
 const raw=await this.powershell("$a=@(Get-NetAdapter -Physical | Where-Object Status -eq 'Up');$r=@(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | Where-Object {$a.ifIndex -contains $_.ifIndex} | ForEach-Object {$i=Get-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $_.ifIndex;[pscustomobject]@{name=$_.InterfaceAlias;index=$_.ifIndex;gateway=$_.NextHop;metric=($_.RouteMetric+$i.InterfaceMetric)}} | Sort-Object metric);if(!$r.Count){throw 'No physical IPv4 route'};$n=$r[0];$ip=@(Get-NetIPAddress -InterfaceIndex $n.index -AddressFamily IPv4 | Where-Object AddressState -eq 'Preferred' | Select-Object -ExpandProperty IPAddress);[pscustomobject]@{name=$n.name;index=$n.index;gateway=$n.gateway;addresses=$ip} | ConvertTo-Json -Compress");return JSON.parse(raw);}
 async freePort(){const s=net.createServer();await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,'127.0.0.1',resolve)});const port=s.address().port;await new Promise(r=>s.close(r));return port;}
 async stopChild(child){if(child.exitCode!==null)return;child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),pause(1800)]);if(child.exitCode===null)child.kill('SIGKILL');}
 async testNode(node,exit,network,core,kind,signal){const folder=await fs.mkdtemp(path.join(this.dataDir,'probe-'));let child,entranceDelay=null;const samples=[];try{
 const port=await this.freePort(),config=isolatedConfig(node,exit,port,network.name,kind,this.dnsPolicy);const file=path.join(folder,'config.yaml');await fs.writeFile(file,YAML.stringify(config),{mode:0o600});
 child=spawn(core,['-d',folder,'-f',file],{windowsHide:true,stdio:'ignore'});this.children.add(child);let spawnError;child.once('error',e=>spawnError=e);
 let ready=false;for(let i=0;i<40;i++){if(signal.aborted)throw Error('已停止');if(spawnError||child.exitCode!==null)throw Error('隔离内核无法启动');ready=await new Promise(r=>{const s=net.connect(port,'127.0.0.1');s.setTimeout(100);s.once('connect',()=>{s.destroy();r(true)});s.once('error',()=>r(false));s.once('timeout',()=>{s.destroy();r(false)});});if(ready)break;await pause(100);}if(!ready)throw Error('临时端口未就绪');
 // Validate the temporary listener belongs to exactly our child before sending a probe.
 const owner=await this.powershell(`@(Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object -ExpandProperty OwningProcess -Unique) | ConvertTo-Json -Compress`);if(!owner||[JSON.parse(owner)].flat().length!==1||JSON.parse(owner)!==child.pid&&JSON.parse(owner)[0]!==child.pid)throw Error('无法确认临时端口归属');
 if(kind==='chain'){const started=performance.now();try{await this.textRequest('https://www.gstatic.com/generate_204',port,{signal,timeout:8000,accept:[204]});entranceDelay=Math.round(performance.now()-started)}catch{}}
 for(let i=0;i<(kind==='chain'?3:1);i++){if(signal.aborted)throw Error('已停止');const start=performance.now();try{const res=await this.trace(port,signal);if(kind==='chain'&&res.ip!==this.expectedIP)throw Error('出口不符：'+res.ip);samples.push({ms:Math.round(performance.now()-start),ip:res.ip});}catch(e){if(!samples.length)throw e;}await pause(100);}
 if(kind==='chain'&&samples.length<2)throw Error('成功样本不足两次');const times=samples.map(x=>x.ms).sort((a,b)=>a-b);return {delay:Math.round((times[Math.floor((times.length-1)/2)]+times[Math.floor(times.length/2)])/2),samples,status:'done',kind,...(kind==='chain'?{entranceDelay}:{})};
 }catch(e){return {delay:null,status:'failed',kind,error:safeError(e),...(kind==='chain'?{entranceDelay}:{})}}finally{if(child){await this.stopChild(child);this.children.delete(child)}await fs.rm(folder,{recursive:true,force:true}).catch(()=>{});}}
 async benchmark(kind='chain'){
 if(this.busy)throw Error('已有操作正在运行');if(!['chain','entrance'].includes(kind))throw Error('无效测速类型');this.busy=true;const abort=new AbortController();this.abort=abort;let reason='';
 try{const before=await this.state();this.assertChain(before);const network=await this.network(),{nodes,exit}=await this.loadNodes(),core=await this.corePath();
 this.progress={running:true,kind,total:before.nodes.length,completed:0,results:{},active:[]};const emit=()=>this.notify('progress',this.progress);emit();
 let next=0;const guard=setInterval(async()=>{try{if(signature(await this.state())!==signature(before)||JSON.stringify(await this.network())!==JSON.stringify(network)){reason='网络或节点已变化，本轮停止；未调整代理';abort.abort();}}catch{reason='无法继续确认当前网络，本轮停止';abort.abort();}},2500);this.guard.add(guard);
 try{await Promise.all(Array.from({length:5},async()=>{while(!abort.signal.aborted){const row=before.nodes[next++];if(!row)break;this.progress.active.push(row.name);emit();let result;
 try{const node=nodes.get(row.name);if(!node)throw Error('订阅缓存缺少该节点，请先更新订阅');result=await this.testNode(node,exit,network,core,kind,abort.signal);}catch(e){result={delay:null,status:'failed',kind,error:safeError(e)};}
 if(!abort.signal.aborted){if(signature(await this.state())!==signature(before)||JSON.stringify(await this.network())!==JSON.stringify(network)){reason='网络或节点变化，已丢弃本次结果';abort.abort();}else{this.progress.results[row.name]={...this.history.results?.[row.name],...result,[kind==='chain'?'chainDelay':'entranceDelay']:result.delay};this.progress.completed++;}}
 this.progress.active=this.progress.active.filter(x=>x!==row.name);emit();}}));}finally{clearInterval(guard);this.guard.delete(guard);}
 this.history={finishedAt:new Date().toISOString(),kind,reason:reason||(abort.signal.aborted?'手动停止':''),results:{...this.history.results,...this.progress.results}};await writeJSON(path.join(this.dataDir,'results.json'),this.history);return this.history;
 }finally{abort.abort();this.busy=false;this.abort=null;this.progress.running=false;this.progress.active=[];this.notify('progress',this.progress);}}
 cancel(){this.abort?.abort();}
 async updateSubscriptions(){return require('./subscriptions.cjs').run(this);}
 async ipv6Probe(host){return new Promise(resolve=>{const s=net.connect({host,port:443,family:6});const finish=v=>{s.destroy();resolve(v)};s.setTimeout(4000);s.once('connect',()=>finish({connected:true,local:s.localAddress}));s.once('error',e=>finish({connected:false,reason:e.code}));s.once('timeout',()=>finish({connected:false,reason:'timeout'}));});}
 async networkCheck(){const interfacesBefore=JSON.stringify(os.networkInterfaces());const safe=async fn=>{try{return await fn()}catch(e){return {error:safeError(e)}}};const s=await this.state();
 const [proxy,tun,v6a,v6b,claudeRaw,connectionSnapshot]=await Promise.all([safe(()=>this.trace(s.mixedPort)),safe(()=>this.trace()),this.ipv6Probe('2606:4700:4700::1111'),this.ipv6Probe('2001:4860:4860::8888'),safe(async()=>{
 if(process.platform!=='win32')throw Error('Claude Code 进程核验需要 Windows');
 const raw=await this.powershell("$p=@(Get-Process -Name claude -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id);$c=@(Get-NetTCPConnection -State Established | Where-Object {$p -contains $_.OwningProcess} | Select-Object OwningProcess,LocalAddress,LocalPort,RemoteAddress,RemotePort);[pscustomobject]@{processCount=$p.Count;connections=$c} | ConvertTo-Json -Depth 5 -Compress");return JSON.parse(raw);
 }),safe(()=>this.api('GET','/connections'))]);
 const addresses=Object.values(os.networkInterfaces()).flat().filter(x=>x&&x.family==='IPv6'&&!x.internal&&!/^(fe[89ab]|f[cd]|::)/i.test(x.address)).map(x=>x.address);
 const claude=claudeRaw.error||connectionSnapshot.error?{status:'warn',detail:'Claude Code 连接未验证：'+(claudeRaw.error||connectionSnapshot.error)}:assessClaude(claudeRaw.connections||[],connectionSnapshot.connections||[],proxy.ip,this.expectedIP);
 let stable=false;try{stable=signature(await this.state())===signature(s)&&JSON.stringify(os.networkInterfaces())===interfacesBefore;}catch{}
 const result={time:new Date().toISOString(),expected:this.expectedIP,stable,state:{mode:s.mode,tun:s.tun,ipv6:s.ipv6,entry:s.entry,exit:s.exit},proxy,tun,ipv6:{...ipv6Assessment(addresses,[v6a,v6b]),addresses,probes:[v6a,v6b]},claude};return result;}
 async shutdown(){this.cancel();for(const t of this.guard)clearInterval(t);await Promise.all([...this.children].map(c=>this.stopChild(c)));}
}
module.exports={Backend,isolatedConfig,signature,ipv6Assessment,assessClaude,nodeAllowed,nodeProvider,EXPECTED,ENTRY,EXIT,writeJSON,safeError};
