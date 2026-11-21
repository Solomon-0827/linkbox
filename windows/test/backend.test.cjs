const test=require('node:test'),assert=require('node:assert/strict'),os=require('node:os'),path=require('node:path'),fs=require('node:fs/promises'),http=require('node:http');
const {Backend,isolatedConfig,ipv6Assessment,assessClaude,EXPECTED}=require('../backend.cjs');
test('isolated configuration never enables live control, TUN or mutates inputs',()=>{const a={name:'入口',type:'ss',server:'example.invalid',port:1},b={name:'美国静态家宽',server:EXPECTED,'dialer-proxy':'中转入口'};const before=JSON.stringify([a,b]);for(const kind of ['chain','entrance']){const c=isolatedConfig(a,b,12345,'Wi-Fi',kind);assert.equal(c.tun.enable,false);assert.equal(c['allow-lan'],false);assert.equal(c['external-controller'],'');assert.equal(c['interface-name'],'Wi-Fi');assert.equal(c.proxies[0]['interface-name'],'Wi-Fi');assert.equal(c.profile['store-selected'],false);assert.equal(c.proxies.length,kind==='chain'?2:1);}assert.equal(JSON.stringify([a,b]),before);assert.throws(()=>isolatedConfig({...a,'dialer-proxy':'other'},b,1,'Wi-Fi'));});
test('IPv6 incomplete probes must never pass',()=>{assert.equal(ipv6Assessment([],[{connected:false},{connected:false}]).status,'ok');assert.equal(ipv6Assessment([],[{},{}]).status,'warn');assert.equal(ipv6Assessment([],[{connected:true},{connected:false}]).status,'warn');assert.equal(ipv6Assessment(['2001:db8::1'],[{connected:false},{connected:false}]).status,'warn');});
test('Claude connections require exact endpoint evidence and verified proxy exit',()=>{const rows=[{LocalPort:5000,LocalAddress:'127.0.0.1',OwningProcess:123}],cons=[{metadata:{sourcePort:'5000',sourceIP:'127.0.0.1',host:'api.anthropic.com'},chains:['美国静态家宽','GLOBAL']}];assert.equal(assessClaude(rows,cons,EXPECTED).status,'ok');assert.equal(assessClaude(rows,cons,'203.0.113.11').status,'warn');assert.equal(assessClaude([],[],EXPECTED).status,'warn');assert.equal(assessClaude(rows,[...cons,...cons],EXPECTED).status,'warn');assert.equal(assessClaude(rows,[{...cons[0],chains:['DIRECT']}],EXPECTED).status,'bad');});
test('live API rejects reloads, connection closes, route patches and deletions',async()=>{const b=new Backend('/tmp');for(const [method,url]of [['PUT','/configs'],['PATCH','/configs'],['DELETE','/connections'],['PUT','/proxies/GLOBAL'],['POST','/restart']])await assert.rejects(b.api(method,url));});
test('switch validates stale state before writes and writes only entrance',async()=>{const b=new Backend('/tmp'),state={mode:'global',tun:true,entry:'a',exit:'美国静态家宽',dialer:'中转入口',nodes:[{name:'a',providerId:'a'},{name:'b',providerId:'a'}],live:['a','b'],switchable:['a','b']};let wrote=[];b.state=async()=>state;b.api=async(m,u,p)=>{wrote.push([m,u,p]);state.entry=p.name};await assert.rejects(b.switchNode('b','stale'));assert.equal(wrote.length,0);await b.switchNode('b','a');assert.deepEqual(wrote,[['PUT','/proxies/'+encodeURIComponent('中转入口'),{name:'b'}]]);});
test('local HTTP API distinguishes a rejection with a body from an empty HTTP error', async () => {
 const server = http.createServer((req, res) => {
  assert.equal(req.headers.authorization, 'Bearer local-test');
  if (req.url === '/version') return res.end('{"version":"test"}');
  res.statusCode = 400;
  res.end(req.url === '/rejected' ? '{"message":"rejected"}' : undefined);
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 try {
  const b = new Backend('/tmp'), endpoint = {hostname:'127.0.0.1',port:server.address().port,secret:'local-test'};
  assert.equal((await b.request(endpoint,'GET','/version')).version, 'test');
  await assert.rejects(b.request(endpoint,'PUT','/rejected'), {rejected:true});
  await assert.rejects(b.request(endpoint,'PUT','/empty'), {rejected:false});
 } finally {
  server.close();
 }
});
test('failed benchmark start preserves display history and invalidates ranking', async t => {
 const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'linkbox-history-'));
 t.after(() => fs.rm(folder, {recursive:true, force:true}));
 const b = await new Backend(folder).init();
 const results = {relay:{owner:'a', chainDelay:10}}, finishedAt = '2026-11-20T00:00:00Z';
 b.state = async () => {throw Error('controller read failed');};
 for (const kind of ['chain', 'entrance']) {
  b.history = {results, finishedAt, latestResults:results};
  await assert.rejects(b.benchmark(kind), /controller read failed/);
  const reopened = await new Backend(folder).init();
  assert.deepEqual(reopened.history, {results, finishedAt, latestResults:{}});
 }
});
test('parallel benchmark is bounded and leaves live API read-only',async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'linkbox-pool-'));try{const b=await new Backend(dir).init();const s={mode:'global',tun:true,entry:'a',exit:'美国静态家宽',dialer:'中转入口',nodes:Array.from({length:8},(_,i)=>({name:String(i)}))};b.state=async()=>s;b.network=async()=>({name:'Wi-Fi',addresses:['192.0.2.2']});b.loadNodes=async()=>({nodes:new Map(s.nodes.map(n=>[n.name,n])),exit:{}});b.corePath=async()=>'mock.exe';b.api=async()=>{throw Error('unexpected mutation')};let active=0,peak=0;b.testNode=async()=>{peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,10));active--;return {delay:100,status:'done',kind:'chain'}};const result=await b.benchmark();assert.equal(Object.keys(result.results).length,8);assert.equal(peak,5);assert.equal(active,0);assert.equal(s.entry,'a');assert.equal(b.busy,false)}finally{await fs.rm(dir,{recursive:true,force:true})}});
test('network changes discard results and do not switch nodes',async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'linkbox-change-'));try{const b=await new Backend(dir).init();let changed=false;const s={mode:'global',entry:'a',exit:'美国静态家宽',dialer:'中转入口',nodes:[{name:'a'}]};b.state=async()=>s;b.network=async()=>({name:changed?'Ethernet':'Wi-Fi'});b.loadNodes=async()=>({nodes:new Map([['a',{}]]),exit:{}});b.corePath=async()=>'mock';b.testNode=async()=>{changed=true;return {delay:123}};const r=await b.benchmark();assert.equal(Object.keys(r.results).length,0);assert.match(r.reason,/变化/);assert.equal(s.entry,'a')}finally{await fs.rm(dir,{recursive:true,force:true})}});
test('a cancelled benchmark never runs remaining nodes',async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'linkbox-cancel-'));try{const b=await new Backend(dir).init();const s={mode:'global',entry:'a',exit:'美国静态家宽',dialer:'中转入口',nodes:Array.from({length:8},(_,i)=>({name:String(i)}))};b.state=async()=>s;b.network=async()=>({name:'Wi-Fi'});b.loadNodes=async()=>({nodes:new Map(s.nodes.map(n=>[n.name,n])),exit:{}});b.corePath=async()=>'mock';let calls=0;b.testNode=async()=>{calls++;b.cancel();return {delay:123}};const r=await b.benchmark();assert.equal(Object.keys(r.results).length,0);assert.ok(calls<=5);assert.equal(b.busy,false);assert.equal(b.progress.running,false)}finally{await fs.rm(dir,{recursive:true,force:true})}});
test('network report records changes during checks without issuing mutations',async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'linkbox-check-'));try{const b=new Backend(dir);let calls=0;b.state=async()=>({mode:'global',tun:true,entry:++calls===1?'WiFi relay':'Ethernet relay',exit:'美国静态家宽',dialer:'中转入口',mixedPort:7897});b.trace=async()=>({ip:EXPECTED});b.ipv6Probe=async()=>({connected:false});b.api=async method=>{assert.equal(method,'GET');return {connections:[]}};const r=await b.networkCheck();assert.equal(r.stable,false);assert.equal(r.proxy.ip,EXPECTED);assert.equal(r.claude.status,'warn');assert.deepEqual(await fs.readdir(dir),[])}finally{await fs.rm(dir,{recursive:true,force:true})}});
test('isolated probes retain provider DNS and never enable TUN',()=>{const policy={'+.example.invalid':['https://dns.example.invalid/dns-query']};const c=isolatedConfig({name:'a'},{name:'b'},12345,'Wi-Fi','chain',policy);assert.deepEqual(c.dns['proxy-server-nameserver-policy'],policy);assert.equal(c.tun.enable,false)});

test('dynamic benchmark limits concurrency and only an opted-in scheduled run changes the relay',async t=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'linkbox-auto-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 const b=await new Backend(folder).init(),names=['current','entrance','chain','failed'];let entry='current',active=0,peak=0,writes=[];
 b.state=async()=>({mode:'global',tun:true,entry,exit:'美国静态家宽',dialer:'中转入口',nodes:names.map(name=>({name,providerId:'a'})),live:names,switchable:names});
 b.network=async()=>({interface:'Wi-Fi'});b.loadNodes=async()=>({nodes:new Map(names.map(name=>[name,{name}])),exit:{}});b.corePath=async()=>'/mock';
 b.api=async(method,route,body)=>{writes.push([method,route,body.name]);entry=body.name};
 b.testNode=async node=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,8));active--;
  const [entranceDelay,delay]={current:[200,400],entrance:[80,260],chain:[90,190],failed:[5,null]}[node.name];return {delay,entranceDelay,status:delay?'done':'failed',kind:'chain'};};
 await Promise.all([b.saveSettings({interval:15,concurrency:2}),b.saveSettings({autoRelay:true,metric:'entrance'})]);
 const restarted=await new Backend(folder).init();assert.deepEqual(restarted.settings,{hourly:true,interval:15,concurrency:2,autoRelay:true,metric:'entrance'});
 await b.benchmark();assert.equal(peak,2);assert.equal(writes.length,0);
 await b.benchmark('chain',()=>false);assert.equal(writes.length,0);
 const run=await b.benchmark('chain',()=>true);assert.equal(run.switchedTo,'entrance');assert.deepEqual(writes,[['PUT','/proxies/'+encodeURIComponent('中转入口'),'entrance']]);
 await b.saveSettings({metric:'chain'});const next=await b.benchmark('chain',()=>true);assert.equal(next.switchedTo,'chain');
 entry='current';const scheduled=b.benchmark('chain',()=>true);await b.saveSettings({autoRelay:false});
 assert.equal((await scheduled).switchedTo,undefined);assert.equal(writes.length,2);
 await b.saveSettings({autoRelay:true});const testNode=b.testNode;b.testNode=async(...args)=>{b.cancel();return testNode(...args)};
 assert.equal((await b.benchmark('chain',()=>true)).switchedTo,undefined);assert.equal(writes.length,2);
});

test('automatic relay checks settings commits and fresh subscription definitions before writing',async t=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'linkbox-auto-race-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 const b=await new Backend(folder).init(),names=['current','candidate'];let endpoint='tested.invalid',loaded=0,writes=0;
 b.state=async()=>({mode:'global',tun:true,entry:'current',exit:'美国静态家宽',dialer:'中转入口',nodes:names.map(name=>({name,providerId:'a'})),live:names,switchable:names});
 b.network=async()=>({name:'Wi-Fi'});b.loadNodes=async()=>{loaded++;return {nodes:new Map(names.map(name=>[name,{name,server:endpoint}])),exit:{}}};b.corePath=async()=>'/mock';
 b.api=async()=>{writes++;};const result=node=>({delay:node.name==='current'?200:50,entranceDelay:50,kind:'chain'});
 await b.saveSettings({autoRelay:true});
 b.testNode=async node=>{endpoint='replacement.invalid';return result(node);};
 assert.equal((await b.benchmark('chain',()=>true)).switchedTo,undefined);assert.equal(loaded,2);assert.equal(writes,0);
 let releaseSave,beginSave,releaseTests,beginTests;
 const saveGate=new Promise(resolve=>releaseSave=resolve),saveStarted=new Promise(resolve=>beginSave=resolve);
 const testsGate=new Promise(resolve=>releaseTests=resolve),testsStarted=new Promise(resolve=>beginTests=resolve);
 const rename=fs.rename;const stub=t.mock.method(fs,'rename',async(from,to)=>{if(to===path.join(folder,'settings.json')){beginSave();await saveGate;}return rename(from,to);});
 b.testNode=async node=>{beginTests();await testsGate;return result(node);};
 const saving=b.saveSettings({autoRelay:false});await saveStarted;
 const running=b.benchmark('chain',()=>true);await testsStarted;releaseSave();await saving;releaseTests();
 assert.equal((await running).switchedTo,undefined);assert.equal(b.settings.autoRelay,false);assert.equal(writes,0);stub.mock.restore();
});

test('benchmark waits for a deferred worker after another post-probe read rejects', async t => {
 const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'linkbox-worker-'));
 t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 const b = await new Backend(folder).init(), names = ['current', 'deferred', 'queued'];
 b.settings.concurrency = 2;
 const state = {mode:'global',tun:true,entry:'current',exit:'美国静态家宽',dialer:'中转入口',nodes:names.map(name=>({name}))};
 let reads = 0;
 b.state = async () => {
  if(++reads === 1) return state;
  throw Error('post-probe state unavailable');
 };
 b.network = async () => ({name:'Wi-Fi'});
 b.loadNodes = async () => ({nodes:new Map(names.map(name=>[name,{name}])),exit:{}});
 b.corePath = async () => '/mock';
 const deferred = Promise.withResolvers(), aborted = Promise.withResolvers(), started = Promise.withResolvers();
 const calls = [];
 b.testNode = async (node, _exit, _network, _core, _kind, signal) => {
  calls.push(node.name);
  if(node.name === 'deferred'){
   signal.addEventListener('abort', aborted.resolve, {once:true});
   started.resolve();
   await deferred.promise;
  }else{
   await started.promise;
  }
  return {delay:100};
 };
 const run = b.benchmark();
 const rejected = assert.rejects(run, /post-probe state unavailable/);
 try{
  await aborted.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.busy,true);
  assert.equal(b.progress.running,true);
  assert.deepEqual(b.progress.active,['deferred']);
  await assert.rejects(b.benchmark(), /已有操作/);
 }finally{
  deferred.resolve();
 }
 await rejected;
 assert.deepEqual(calls,['current','deferred']);
 assert.equal(b.busy,false);
 assert.equal(b.progress.running,false);
});

test('benchmark loads duplicate credentials only from the selected owner and includes the current baseline', async t => {
 const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'linkbox-owner-'));
 t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 const b = await new Backend(folder).init(), ENTRY = '中转入口', EXIT = '美国静态家宽';
 const node = server => ({name:'same',server});
 const config = {proxies:[node('local.example.invalid'),{name:EXIT,server:'203.0.113.10','dialer-proxy':ENTRY}],
  'proxy-providers':{a:{payload:[node('a.example.invalid')]},b:{payload:[node('b.example.invalid')]}},
  'proxy-groups':[{name:ENTRY,use:['a','b']}]};
 b.config = async () => config;
 b.api = async (method,route) => {
  assert.equal(method,'GET');
  if(route==='/configs')return {mode:'global'};
  if(route==='/proxies')return {proxies:{
   GLOBAL:{now:EXIT},[ENTRY]:{now:'same',all:['same','outside']},[EXIT]:{'dialer-proxy':ENTRY},
  }};
  return {providers:{a:{proxies:[node('a.example.invalid')]},b:{proxies:[node('b.example.invalid')]}}};
 };
 for(const owner of ['a','b']){
  await fs.writeFile(path.join(folder,'node-policy.json'),JSON.stringify({selected_nodes:{[owner]:['same','selected']}}));
  const {nodes} = await b.loadNodes();
  assert.equal(nodes.get('same').server, owner+'.example.invalid');
  const state = await b.state();
  assert.deepEqual(state.nodes.map(n=>[n.name,n.providerId]),[['same',owner],['selected',owner]]);
  assert.deepEqual(state.switchable,[]);
 }
});

for (const automatic of [false, true]) for (const changedAfterPut of [false, true]) {
 test(`${automatic ? 'automatic' : 'manual'} switch refuses wrong owner ${changedAfterPut ? 'after' : 'before'} PUT`, async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'linkbox-switch-owner-'));
  t.after(() => fs.rm(folder, {recursive:true, force:true}));
  const {ENTRY, EXIT} = require('../backend.cjs');
  const b = await new Backend(folder).init();
  b.settings.autoRelay = true;
  await fs.writeFile(path.join(folder, 'node-policy.json'), JSON.stringify({selected_nodes:{a:['current','same']}}));
  const current = {name:'current',server:'current.invalid'}, same = {name:'same',server:'a.invalid'};
  const exit = {name:EXIT,server:'203.0.113.10','dialer-proxy':ENTRY};
  const revision = 'https://www.gstatic.com/generate_204#linkbox-0123456789abcdef0123456789abcdef';
  b.config = async () => ({proxies:[exit], 'proxy-providers':{a:{payload:[current,same]}},
   'proxy-groups':[{name:ENTRY,use:['a'],url:revision}]});
  b.network = async () => ({interface:'Wi-Fi'});
  b.corePath = async () => '/mock';
  b.testNode = async node => ({delay: node.name === 'current' ? 400 : 100});
  let entry = 'current', entryOwner = changedAfterPut ? 'a' : 'b';
  const writes = [];
  b.api = async (method, route, body) => {
   if(method === 'PUT'){
    writes.push(body.name);entry = body.name;entryOwner = 'b';return;
   }
   if(route === '/configs') return {mode:'global'};
   if(route === '/proxies') return {proxies:{
    GLOBAL:{now:EXIT}, [ENTRY]:{now:entry,all:['current','same'],testUrl:revision}, [EXIT]:{'dialer-proxy':ENTRY},
    secondary:{all:['same'],now:'same'},
   }};
   const providers = {a:{proxies:[current,same]}};
   if(entryOwner === 'b') providers.b = {proxies:[current,{name:'same',server:'b.invalid'}]};
   return {providers};
  };
  const run = automatic ? () => b.benchmark('chain', () => true) : () => b.switchNode('same','current');
  await assert.rejects(run, changedAfterPut ? /待核对/ : /归属/);
  assert.deepEqual(writes, changedAfterPut ? ['same'] : []);
 });
}

for (const automatic of [false, true]) for (const wrongGroup of [false, true]) test(
 `${automatic ? 'automatic' : 'manual'} switch ${wrongGroup ? 'rejects a different live ENTRY provider' : 'ignores a duplicate loaded by another group'}`, async t => {
 const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'linkbox-switch-group-'));
 t.after(() => fs.rm(folder, {recursive:true, force:true}));
 const {ENTRY, EXIT} = require('../backend.cjs');
 const b = await new Backend(folder).init();
 b.settings.autoRelay = true;
 await fs.writeFile(path.join(folder, 'node-policy.json'), JSON.stringify({selected_nodes:{a:['current','same']}}));
 const current = {name:'current',server:'current.invalid'}, same = {name:'same',server:'a.invalid'};
 const exit = {name:EXIT,server:'203.0.113.10','dialer-proxy':ENTRY};
 const revision = owner => 'https://www.gstatic.com/generate_204#linkbox-0123456789abcdef0123456789abcdef:' + owner;
 const config = {proxies:[exit], 'proxy-providers':{a:{payload:[current,same]}},
  'proxy-groups':[{name:ENTRY,use:['a'],url:revision('a')},{name:'secondary',use:[wrongGroup?'a':'b']}]};
 b.config = async () => config;
 b.network = async () => ({interface:'fixture'});
 b.corePath = async () => '/mock';
 b.testNode = async node => ({delay:node.name === 'current' ? 400 : 100});
 let entry = 'current';
 b.api = async (method, route, body) => {
  if (method === 'PUT') {entry = body.name;return;}
  if (route === '/configs') return {mode:'global'};
  if (route === '/proxies') return {proxies:{
   GLOBAL:{now:EXIT},[ENTRY]:{now:entry,all:['current','same'],testUrl:revision('a')},[EXIT]:{'dialer-proxy':ENTRY},
   secondary:{now:'same',all:['same']},
  }};
  return {providers:{a:{proxies:[current,same]},b:{
   proxies:[...(wrongGroup?[current]:[]),{name:'same',server:'b.invalid'}]}}};
 };
 if (wrongGroup) {
  const run = automatic ? () => b.benchmark('chain', () => true) : () => b.switchNode('same','current');
  await assert.rejects(run, /节点归属/);
  assert.equal(entry, 'current');
  return;
 }
 if (automatic) assert.equal((await b.benchmark('chain', () => true)).switchedTo, 'same');
 else assert.equal((await b.switchNode('same','current')).entry, 'same');
 assert.equal(entry, 'same');
});
