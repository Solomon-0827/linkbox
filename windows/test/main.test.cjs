const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('real coffee IPC helper returns its shared detection object and preserves editing protection',async()=>{let created=0,destroyed=0;const sample={score:'100',ip:'203.0.113.10',props:{type:'ISP'},dns:{result:'ok'},udp:{result:'ok'}};
class Window{constructor(){created++;this.webContents={setWindowOpenHandler(){},executeJavaScript:async()=>sample}}async loadURL(){}destroy(){destroyed++}}
const electron={app:{setName(){},requestSingleInstanceLock:()=>false,quit(){}},nativeTheme:{},ipcMain:{handle(){}},session:{fromPartition:()=>({setProxy:async()=>{},setPermissionRequestHandler(){}})},BrowserWindow:Window};
const context=vm.createContext({require:name=>name==='electron'?electron:name==='node:fs/promises'?{readFile:async()=>''}:name==='./backend.cjs'?{}:name==='./subscriptions.cjs'?{}:require(name),process:{argv:[],platform:'darwin'},__dirname:__dirname,setTimeout,clearInterval,console});vm.runInContext(fs.readFileSync(require.resolve('../main.cjs'),'utf8'),context);const result=await vm.runInContext("backend={state:async()=>({mixedPort:7897})};uiActive=true;Promise.all([coffee(),coffee()]).then(values=>({values,active:uiActive}))",context);assert.equal(created,1);assert.equal(destroyed,1);assert.equal(result.values[0].score,'100');assert.equal(result.values[1].ip,sample.ip);assert.equal(result.active,true)});

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

test('every renderer action crosses the real preload allowlist and has a main IPC handler', async () => {
 const renderer=fs.readFileSync(require.resolve('../renderer.js'),'utf8')
  .replace('function call(a,d)', 'function invokeAction(a,d)').replace('window.linkbox.call(a,d)', 'bridge(a,d)');
 const calls=[...renderer.matchAll(/(?:window\.linkbox\.call|(?<![.\w])call)\(\s*([^,()]+)\s*(?=[,)])/g)].map(match=>match[1].trim());
 assert.ok(calls.length>0);
 assert.ok(calls.every(arg=>/^'\w+'$/.test(arg)), 'Renderer actions must be statically enumerable');
 const actions=new Set(calls.map(arg=>arg.slice(1,-1)));
 assert.ok(actions.has('benchmarkSettings'));
 const webContents={mainFrame:{}};
 let mainHandler, bridge;
 const electron={
  app:{setName(){},requestSingleInstanceLock:()=>false,quit(){}},nativeTheme:{},
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
  {catalog:stub,run:stub,remove:stub}:name==='./backend.cjs'?{safeError:e=>e.message,benchmarkSettings:()=>({})}:require(name),
  process:{argv:[],platform:'darwin'},__dirname,backendStub:backend,webContents,clearInterval});
 vm.runInContext(fs.readFileSync(require.resolve('../main.cjs'),'utf8'),context);
 vm.runInContext('backend=backendStub;win={webContents};coffee=async()=>({})',context);
 vm.runInContext(fs.readFileSync(require.resolve('../preload.cjs'),'utf8'),context);
 const payloads={copyIP:{ip:'203.0.113.10'},switch:{name:'selected',previous:'current'},settings:{hourly:false},downloadReport:{},saveSelection:{}};
 for(const action of actions){
  const response=await bridge.call(action,payloads[action]);
  assert.equal(response.ok,true,`${action}: ${response.error||''}`);
 }
});
