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
