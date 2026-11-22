const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('real coffee IPC helper returns its shared detection object and preserves editing protection',async()=>{let created=0,destroyed=0;const sample={score:'100',ip:'203.0.113.10',props:{type:'ISP'},dns:{result:'ok'},udp:{result:'ok'}};
class Window{constructor(){created++;this.webContents={setWindowOpenHandler(){},executeJavaScript:async()=>sample}}async loadURL(){}destroy(){destroyed++}}
const electron={app:{setName(){},requestSingleInstanceLock:()=>false,quit(){}},nativeTheme:{},ipcMain:{handle(){}},session:{fromPartition:()=>({setProxy:async()=>{},setPermissionRequestHandler(){}})},BrowserWindow:Window};
const context=vm.createContext({require:name=>name==='electron'?electron:name==='node:fs/promises'?{readFile:async()=>''}:name==='./backend.cjs'?{}:name==='./subscriptions.cjs'?{}:require(name.startsWith('./')?'../'+name.slice(2):name),process:{argv:[],platform:'darwin'},__dirname:__dirname,setTimeout,clearInterval,console});vm.runInContext(fs.readFileSync(require.resolve('../main.cjs'),'utf8'),context);const result=await vm.runInContext("backend={state:async()=>({mixedPort:7897})};uiActive=true;Promise.all([coffee(),coffee()]).then(values=>({values,active:uiActive}))",context);assert.equal(created,1);assert.equal(destroyed,1);assert.equal(result.values[0].score,'100');assert.equal(result.values[1].ip,sample.ip);assert.equal(result.active,true)});

test('dynamic scheduler replaces its previous timer and skips while the UI is busy',async()=>{
 const calls=[],intervals=[],cleared=[],notifications=[];
 const electron={app:{setName(){},requestSingleInstanceLock:()=>false,quit(){}},nativeTheme:{},ipcMain:{handle(){}}};
 const context=vm.createContext({require:name=>name==='electron'?electron:require(name.startsWith('./')?'../'+name.slice(2):name),process:{argv:[],platform:'darwin'},__dirname,
  clearInterval:id=>{if(id)cleared.push(id)},setInterval:(fn,ms)=>{intervals.push({fn,ms});return intervals.length},console});
 vm.runInContext(fs.readFileSync(require.resolve('../main.cjs'),'utf8'),context);
 context.fake={settings:{hourly:true},benchmark:async(kind,allowed)=>{calls.push([kind,allowed()]);return {}}};
 context.notify=(...args)=>notifications.push(args);
 vm.runInContext("backend=fake;win={webContents:{send:notify}};scheduleAuto();backend.settings.interval=15;scheduleAuto();uiActive=true",context);
 assert.deepEqual(intervals.map(t=>t.ms),[3600000,900000]);assert.deepEqual(cleared,[1]);
 await intervals[1].fn();assert.equal(calls.length,0);
 vm.runInContext('uiActive=false',context);await intervals[1].fn();assert.deepEqual(calls,[['chain',true]]);assert.equal(notifications[0][0],'automatic');
 vm.runInContext('backend.settings.hourly=false;scheduleAuto()',context);assert.deepEqual(cleared,[1,2]);assert.equal(intervals.length,2);
});

function loadRenderer(call, setInterval=()=>{}, globals={}) {
 const elements = new Map();
 const element = () => ({value:'',classList:{add(){},remove(){},toggle(){}},replaceChildren(){},
  setAttribute(){},addEventListener(){},append(){}});
 const select = id => {
  if (!elements.has(id)) elements.set(id,element());
  return elements.get(id);
 };
 const context = vm.createContext({
  document:{querySelector:select,querySelectorAll:()=>[],addEventListener(){},
   createElement:element,createDocumentFragment:element},
  window:{linkbox:{call,onProgress(){},onAutomatic(){}}},setInterval,URL,...globals,
 });
 const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
 for(const [,src] of html.matchAll(/<script src="([^"]+)"><\/script>/g)){
  vm.runInContext(fs.readFileSync(require.resolve('../'+src),'utf8'),context);
 }
 return {select, context};
}

test('benchmark interval errors use the macOS field message', async t => {
 const {benchmarkChanges}=require('../preferences.cjs');
 const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
 await t.test('out of range reaches shared validation without a browser bubble',()=>{
  const form=html.match(/<form\b[^>]*\bid="autoSettingsForm"[^>]*>/)?.[0];
  assert.match(form,/\bnovalidate\b/);
 });
 for(const [value,numeric] of [['1e2',100],['1441',1441],['0',0]]){
  await t.test(`rejects ${value}`,async()=>{
   const {select}=loadRenderer(async(action,values)=>{
    if(action!=='settings')return {ok:false,error:'offline'};
    try{return {ok:true,data:benchmarkChanges(values)}}
    catch(error){return {ok:false,error:error.message}}
   });
   Object.assign(select('#testInterval'),{value,valueAsNumber:numeric});
   Object.assign(select('#testConcurrency'),{value:'5',valueAsNumber:5});
   select('#autoRelay').checked=false;
   select('#autoMetric').value='chain';
   let closed=false;
   select('#autoSettings').close=()=>{closed=true;};
   await select('#autoSettingsForm').onsubmit({preventDefault(){}});
   assert.equal(closed,false);
   assert.equal(select('#autoSettingsNotice').textContent,'测速间隔须为 1–1440 分钟。');
  });
 }
});

test('network check cards compare parsed browser and system addresses',async()=>{
 for(const {name,expected,probe,matches} of require('../../fixtures/ip-comparison.json')){
  const {select}=loadRenderer(async action=>{
   if(action==='check')return {ok:true,data:{expected,tun:{ip:probe},proxy:{ip:probe},
    ipv6:{addresses:[],probes:[{},{}]},claude:{matched:[],other:[]}}};
   return {ok:false,error:'offline'};
  },undefined,{AbortController,setTimeout,clearTimeout,fetch:async url=>({ok:true,text:async()=>
   url.includes('trace')?'ip='+probe:JSON.stringify({ip:probe})})});
  select('#report').showModal=()=>{};
  const cards=[];
  select('#checkRows').append=card=>cards.push(card.className);
  await select('#check').onclick();
  assert.equal(cards[0],'check-card '+(matches?'ok':probe?'bad':'warn'),name);
  assert.equal(cards[4],'check-card '+(matches?'ok':probe?'bad':'warn'),name);
 }
});

test('browser probes keep their initial expected IP if the system check fails',async()=>{
 const priorIP='203.0.113.10',nextIP='203.0.113.11';
 let expectedIP=priorIP;
 const probe=Promise.withResolvers();
 const {select}=loadRenderer(async action=>{
  if(action==='state')return {ok:true,data:{expectedIP,nodes:[],settings:{}}};
  return {ok:false,error:'offline'};
 },undefined,{AbortController,setTimeout,clearTimeout,fetch:async url=>{
  const ip=await probe.promise;
  return {ok:true,text:async()=>url.includes('trace')?'ip='+ip:JSON.stringify({ip})};
 }});
 await new Promise(resolve=>setImmediate(resolve));
 select('#report').showModal=()=>{};
 const cards=[];
 select('#checkRows').append=card=>cards.push(card.className);

 const pending=select('#check').onclick();
 expectedIP=nextIP;
 await select('#refresh').onclick();
 probe.resolve(priorIP);
 await pending;
 assert.deepEqual(cards.slice(0,3),['check-card warn','check-card ok','check-card ok']);
});

test('network report downloads still include the native assessments alongside the evidence',async()=>{
 const ip='203.0.113.10';
 const ipv6={addresses:[],probes:[{connected:false},{connected:false}]};
 const claude={matched:[{chains:['美国静态家宽']}],other:[]};
 const native={expected:ip,stable:true,tun:{ip},proxy:{ip},ipv6,claude};
 let downloaded;
 const {select}=loadRenderer(async(action,value)=>{
  if(action==='check')return {ok:true,data:native};
  if(action==='downloadReport'){downloaded=JSON.parse(JSON.stringify(value));return {ok:true};}
  return {ok:false,error:'offline'};
 },undefined,{AbortController,setTimeout,clearTimeout,fetch:async url=>({ok:true,text:async()=>
  url.includes('trace')?'ip='+ip:JSON.stringify({ip})})});
 select('#report').showModal=()=>{};

 await select('#check').onclick();
 assert.equal(select('#downloadReport').hidden,false);
 await select('#downloadReport').onclick();
 assert.deepEqual(downloaded.native,{
  ...native,
  ipv6:{status:'ok',detail:'无公网 IPv6 地址，两个公网目标均连接失败；本轮未发现绕过通路',...ipv6},
  claude:{status:'ok',detail:'1/1 条 Claude Code 连接匹配美国静态家宽；0 条未匹配',...claude},
 });
});

test('only startup and manual Refresh retry transient initialization failures', async () => {
 let calls = 0, handler;
 const webContents = {mainFrame:{}}, event = {sender:webContents,senderFrame:webContents.mainFrame};
 const electron = {app:{setName(){},requestSingleInstanceLock:()=>false,quit(){}},nativeTheme:{},
  ipcMain:{handle(_channel,fn){handler=fn;}}};
 const subscriptions = {async startup(){
  if (++calls === 1) throw Error('offline');
  if (calls === 2) throw Error('订阅下载失败');
  return {changed:true};
 }};
 const fake = {root:'fixture',state:async()=>({
  mode:'global',exit:'美国静态家宽',dialer:'中转入口',entry:'current',nodes:[],settings:{},expectedIP:'203.0.113.10',
 })};
 const context = vm.createContext({require:name=>name==='electron'?electron:name==='./subscriptions.cjs'?subscriptions:
  name==='./backend.cjs'?{safeError:e=>e.message}:require(name.startsWith('./')?'../'+name.slice(2):name),process:{argv:[],platform:'darwin'},__dirname,fake,webContents});
 vm.runInContext(fs.readFileSync(require.resolve('../main.cjs'),'utf8'),context);
 vm.runInContext('backend=fake;win={webContents}',context);
 const reads = [];
 let poll;
 const {select} = loadRenderer(async (action,data)=>{
  if (action !== 'state') return {ok:true,data:{ip:'203.0.113.10'}};
  reads.push(data?.initialize === true);
  return handler(event,action,data);
 },(fn,ms)=>{assert.equal(ms,30000);poll=fn;});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(select('#notice').textContent,'offline');
 for (let i=0;i<5;i++) {
  poll();
  await new Promise(resolve=>setImmediate(resolve));
 }
 assert.equal(calls,1);
 assert.equal(select('#notice').textContent,'offline');
 await select('#refresh').onclick();
 assert.equal(select('#notice').textContent,'订阅下载失败');
 assert.equal(vm.runInContext('startupChecked',context),false);
 assert.equal(calls,2);
 await select('#refresh').onclick();
 assert.equal(calls,3);
 assert.equal(vm.runInContext('initializedSelection',context),true);
 assert.deepEqual(reads,[true,false,false,false,false,false,true,true]);
});

test('choosing the Clash directory initializes and populates the first node list', async () => {
 const webContents = {mainFrame:{}}, event = {sender:webContents,senderFrame:webContents.mainFrame};
 let handler, selected = false, initializations = 0, canceled = true;
 const electron = {app:{setName(){},requestSingleInstanceLock:()=>false,quit(){}},nativeTheme:{},
  dialog:{showOpenDialog:async()=>({canceled,filePaths:['fixture-clash']})},
  ipcMain:{handle(_channel,fn){handler=fn;}}};
 const fake = {
  async saveSettings({configDir}) {assert.equal(configDir,'fixture-clash');selected=true;},
  async state() {
   if(!selected)throw Error('configuration directory not found');
   return {mode:'global',exit:'美国静态家宽',dialer:'中转入口',entry:'current',
    nodes:initializations?[{name:'current'}]:[],settings:{},expectedIP:'203.0.113.10'};
  },
 };
 const subscriptions = {async startup(){initializations++;return {changed:true};}};
 const main = vm.createContext({require:name=>name==='electron'?electron:name==='./subscriptions.cjs'?subscriptions:
  name==='./backend.cjs'?{safeError:e=>e.message}:require(name.startsWith('./')?'../'+name.slice(2):name),process:{argv:[],platform:'darwin'},__dirname,fake,webContents});
 vm.runInContext(fs.readFileSync(require.resolve('../main.cjs'),'utf8'),main);
 vm.runInContext('backend=fake;win={webContents}',main);
 const renderer = loadRenderer((action,data)=>handler(event,action,data));
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(initializations,0);
 await renderer.select('#chooseConfig').onclick();
 assert.equal(initializations,0);
 canceled=false;
 await renderer.select('#chooseConfig').onclick();
 assert.equal(initializations,1);
 assert.equal(vm.runInContext('state.nodes[0].name',renderer.context),'current');
});

test('Windows quit waits for the subscription update to settle', async t => {
 const path = require('node:path');
 const dataDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(),'linkbox-quit-'));
 t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
 let beforeQuit, settle, enter, prevented = 0, exited = 0, shutdowns = 0, message;
 const quit = () => {
  let blocked = false;
  beforeQuit({preventDefault(){blocked=true;prevented++;}});
  if(!blocked)exited++;
 };
 const app = {setName(){},setAppUserModelId(){},requestSingleInstanceLock:()=>true,quit,
  on(event,fn){if(event==='before-quit')beforeQuit=fn;},whenReady:()=>new Promise(()=>{})};
 const paused = new Promise(resolve=>{settle=resolve;});
 const entered = new Promise(resolve=>{enter=resolve;});
 const fake = {dataDir,clash:{async config(){return {root:dataDir};}},
  async state(){enter();await paused;throw Error('fixture stop');},async shutdown(){shutdowns++;}};
 const electron = {app,nativeTheme:{},ipcMain:{handle(){}}};
 const context = vm.createContext({require:name=>name==='electron'?electron:
  require(name.startsWith('./')?'../'+name.slice(2):name),process:{argv:[],platform:'win32'},__dirname,
  clearInterval,fake,balloon:value=>{message=value.content;}});
 vm.runInContext(fs.readFileSync(require.resolve('../main.cjs'),'utf8'),context);
 vm.runInContext('backend=fake;tray={displayBalloon:balloon}',context);
 const completed = assert.rejects(require('../subscriptions.cjs').run(fake),/fixture stop/);
 await entered;
 quit();
 quit();
 await new Promise(resolve=>setImmediate(resolve));
 settle();
 assert.equal(prevented,2);
 assert.equal(exited,0);
 assert.equal(shutdowns,0);
 assert.match(message,/正在更新订阅/);
 await completed;
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(shutdowns,1);
 assert.equal(exited,1);
});

test('every renderer action crosses the real preload allowlist and has a main IPC handler', async () => {
 const renderer=fs.readFileSync(require.resolve('../renderer.js'),'utf8')
  .replace('function call(a,d)', 'function invokeAction(a,d)').replace('window.linkbox.call(a,d)', 'bridge(a,d)');
 const calls=[...renderer.matchAll(/(?:window\.linkbox\.call|(?<![.\w])call)\(\s*([^,()]+)\s*(?=[,)])/g)].map(match=>match[1].trim());
 assert.ok(calls.length>0);
 assert.ok(calls.every(arg=>/^'\w+'$/.test(arg)), 'Renderer actions must be statically enumerable');
 const actions=new Set(calls.map(arg=>arg.slice(1,-1)));
 assert.ok(actions.has('benchmarkSettings'));
 const webContents={mainFrame:{},setWindowOpenHandler(){},on(){}};
 let mainHandler, bridge, webPreferences;
 const electron={
  app:{setName(){},requestSingleInstanceLock:()=>true,quit(){},on(){},whenReady:async()=>{},getPath:()=>''},
  nativeTheme:{},session:{defaultSession:{setPermissionRequestHandler(){}}},
  BrowserWindow:class {
   constructor(options){webPreferences=options.webPreferences;this.webContents=webContents;}
   removeMenu(){} on(){} async loadFile(){} show(){}
  },
  Tray:class {setToolTip(){} setContextMenu(){} on(){}},
  nativeImage:{createFromPath:()=>({resize(){}})},Menu:{buildFromTemplate(){}},
  ipcMain:{handle(_channel,callback){mainHandler=callback;}},
  ipcRenderer:{invoke(channel,action,data){
   assert.equal(channel,'linkbox');
   return mainHandler({sender:webContents,senderFrame:webContents.mainFrame},action,data);
  }},
  contextBridge:{exposeInMainWorld(_name,value){bridge=value;}},
  clipboard:{writeText(){}},dialog:{showSaveDialog:async()=>({canceled:true}),showOpenDialog:async()=>({canceled:true})},
  shell:{openExternal:async()=>{},openPath:async()=>{}},
 };
 const stub=async()=>({});
 const backend={settings:{hourly:false},state:stub,ipInfo:stub,switchNode:stub,benchmark:stub,cancel:stub,
  updateSubscriptions:stub,networkCheck:stub,saveSettings:stub};
 const context=vm.createContext({require:name=>name==='electron'?electron:name==='./subscriptions.cjs'?
  {catalog:stub,run:stub,remove:stub}:name==='./backend.cjs'?{Backend:class {async init(){return backend;}},safeError:e=>e.message}:
   require(name.startsWith('./')?'../'+name.slice(2):name),
  process:{argv:[],platform:'darwin'},__dirname,clearInterval,setTimeout(){}});
 vm.runInContext(fs.readFileSync(require.resolve('../main.cjs'),'utf8'),context);
 await new Promise(resolve=>setImmediate(resolve));
 vm.runInContext('coffee=async()=>({})',context);
 assert.equal(webPreferences.sandbox,true);
 const [commandArg]=webPreferences.additionalArguments;
 assert.deepEqual(new Set(JSON.parse(commandArg.split('=')[1])),actions);
 const preload=vm.createContext({
  process:{argv:[commandArg]},require(name){assert.equal(name,'electron');return electron;},
 });
 vm.runInContext(fs.readFileSync(require.resolve('../preload.cjs'),'utf8'),preload);
 assert.throws(()=>bridge.call('toString'),/不支持的操作/);
 const rejected=await mainHandler({sender:webContents,senderFrame:webContents.mainFrame},'toString');
 assert.equal(rejected.ok,false);
 const payloads={copyIP:{ip:'203.0.113.10'},switch:{name:'selected',previous:'current'},settings:{hourly:false},downloadReport:{},saveSelection:{}};
 for(const action of actions){
  const response=await bridge.call(action,payloads[action]);
  assert.equal(response.ok,true,`${action}: ${response.error||''}`);
 }
});
