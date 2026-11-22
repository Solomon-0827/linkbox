'use strict';
const {app,BrowserWindow,ipcMain,Tray,Menu,nativeImage,shell,dialog,session,nativeTheme,clipboard}=require('electron');
const path=require('node:path'),fs=require('node:fs/promises');
const {Backend,writeJSON,safeError}=require('./backend.cjs');
const {benchmarkSettings,benchmarkChanges}=require('./preferences.cjs');
const subscriptions=require('./subscriptions.cjs');
const DEMO=process.argv.includes('--demo');let win,tray,backend,quitting=false,readyToQuit=false,timer,coffeeWindow,coffeePending,uiActive=false;
async function auto(){
 if(DEMO||quitting||backend.settings.hourly===false||backend.busy||uiActive)return;
 try{const result=await backend.benchmark('chain',()=>!quitting&&!uiActive);win?.webContents.send('automatic',{ok:true,switchedTo:result.switchedTo,switchWarning:result.switchWarning});}
 catch(e){win?.webContents.send('automatic',{error:safeError(e)});}
}
function scheduleAuto(){clearInterval(timer);if(!DEMO&&backend.settings.hourly!==false)timer=setInterval(auto,benchmarkSettings(backend.settings).interval*60000);}
app.setName('链路盒子');nativeTheme.themeSource='light';if(process.platform==='win32')app.setAppUserModelId('local.linkbox.windows');
if(!app.requestSingleInstanceLock()){app.quit();}else{
app.on('second-instance',()=>{win?.show();win?.focus()});
app.on('window-all-closed',()=>{});
app.on('before-quit',event=>{
 if(readyToQuit)return;
 event.preventDefault();
 if(quitting)return;
 quitting=true;
 clearInterval(timer);
 const pending=backend?.subscriptionUpdate;
 if(pending&&process.platform==='win32')tray?.displayBalloon({title:'链路盒子',content:'正在更新订阅，完成后将退出。'});
 Promise.resolve(pending).catch(()=>{}).then(()=>backend?.shutdown()).finally(()=>{
  readyToQuit=true;
  app.quit();
 }).catch(()=>{});
});
app.whenReady().then(async()=>{
 backend=await new Backend(app.getPath('userData'),(name,data)=>win?.webContents.send(name,data)).init();
 win=new BrowserWindow({width:1000,height:790,minWidth:900,minHeight:650,show:false,title:'链路盒子',backgroundColor:'#ffffff',icon:path.join(__dirname,'icon.png'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,additionalArguments:[commandArgument()]}});
 win.removeMenu();win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',(e)=>e.preventDefault());
 session.defaultSession.setPermissionRequestHandler((_wc,_p,cb)=>cb(false));
 win.on('close',e=>{if(!quitting){e.preventDefault();win.hide();}});await win.loadFile('index.html');win.show();
 tray=new Tray(nativeImage.createFromPath(path.join(__dirname,'icon.png')).resize({width:32,height:32}));tray.setToolTip('链路盒子 · 后台运行');tray.setContextMenu(Menu.buildFromTemplate([{label:'打开链路盒子',click:()=>win.show()},{label:'停止测速',click:()=>backend.cancel()},{type:'separator'},{label:'退出链路盒子',click:()=>app.quit()}]));tray.on('double-click',()=>win.show());
 scheduleAuto();
 if(!DEMO)setTimeout(()=>{if(startupChecked&&!initializedSelection)auto();},12000);
});
}
async function coffee(){if(coffeePending)return coffeePending;coffeePending=(async()=>{
 const s=await backend.state(),ses=session.fromPartition('netcoffee');await ses.setProxy({proxyRules:`http=127.0.0.1:${s.mixedPort};https=127.0.0.1:${s.mixedPort}`,proxyBypassRules:'<-loopback>'});
 ses.setPermissionRequestHandler((_w,_p,cb)=>cb(false));coffeeWindow=new BrowserWindow({show:false,webPreferences:{session:ses,nodeIntegration:false,contextIsolation:true,sandbox:true}});coffeeWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 const code=await fs.readFile(path.join(__dirname,'coffee-extract.js'),'utf8');let last={};try{await coffeeWindow.loadURL('https://ip.net.coffee/claude/');const until=Date.now()+45000;while(Date.now()<until){last=await coffeeWindow.webContents.executeJavaScript(code);if(/^\d+$/.test(last.score)&&last.ip&&Object.values(last.udp||{}).some(Boolean)&&Object.values(last.dns||{}).some(Boolean))break;await new Promise(r=>setTimeout(r,1500));}return {...last,time:new Date().toISOString()};}finally{coffeeWindow?.destroy();coffeeWindow=null;}})();try{return await coffeePending;}finally{coffeePending=null;}}
const demoNodes=['日本 JP V1-3','香港 HK 01','新加坡 SG 02','日本 JP V1-2','美国新 ISP A1','香港 HK 02'].map((name,i)=>({name,provider:i%2?'mmti':'Neko',delay:[286,312,349,422,null,518][i],status:i===4?'failed':'done',kind:'chain'}));
let initialization,startupChecked=false,initializedSelection=false;
async function startupState(){
 const state=await backend.state();
 if(quitting)return state;
 const ready=state.mode==='global'&&state.exit==='美国静态家宽'&&state.dialer==='中转入口';
 initialization ||= subscriptions.startup(backend,ready)
  .catch(error=>({changed:false,selectionError:safeError(error)}));
 const pending=initialization;
 const {changed,selectionError}=await pending;
 if(initialization===pending){
  initialization=null;
  startupChecked=ready&&!selectionError;
  initializedSelection||=changed;
 }
 return {...(changed?await backend.state():state),selectionError};
}
async function chooseConnection(dir){
 const r=await dialog.showOpenDialog(win,{title:dir?'选择 Clash Verge 配置目录':'选择 verge-mihomo.exe',properties:[dir?'openDirectory':'openFile'],...(dir?{}:{filters:[{name:'Mihomo 内核',extensions:['exe']}]})});
 if(!r.canceled&&!quitting)await backend.saveSettings({[dir?'configDir':'corePath']:r.filePaths[0]});
 return {changed:!r.canceled&&!quitting};
}
const commands={
 state: data=>data?.initialize===true?startupState():backend.state(),
 ip: ()=>backend.ipInfo(),
 coffee: ()=>coffee(),
 switch(data){
  if(typeof data?.name!=='string'||typeof data?.previous!=='string')throw Error('无效节点');
  return backend.switchNode(data.name,data.previous);
 },
 benchmark: kind=>backend.benchmark(kind),
 cancel(){backend.cancel();return {};},
 update: ()=>backend.updateSubscriptions(),
 check: ()=>backend.networkCheck(),
 copyIP(data){
  if(!require('node:net').isIP(data?.ip||''))throw Error('尚无有效出口 IP');
  clipboard.writeText(data.ip);return {};
 },
 activity(data){uiActive=!!data?.active;return {};},
 catalog: data=>subscriptions.catalog(backend,data?.changes),
 saveSelection(data){
  if(!data||typeof data!=='object'||Array.isArray(data))throw Error('节点选择无效，请重新打开管理节点');
  return subscriptions.run(backend,data);
 },
 removeNodes: data=>subscriptions.remove(backend,data),
 async downloadReport(data){
  if(!data||JSON.stringify(data).length>60000)throw Error('无效检查报告');
  const r=await dialog.showSaveDialog(win,{title:'下载网络检查报告',defaultPath:'LinkBox-network-check-'+new Date().toISOString().slice(0,10)+'.json',filters:[{name:'JSON',extensions:['json']}]});
  if(!r.canceled&&r.filePath)await writeJSON(r.filePath,data);
  return {};
 },
 benchmarkSettings: ()=>benchmarkSettings(backend.settings),
 async settings(data){
  const changes=benchmarkChanges(data);
  await backend.saveSettings(changes);
  scheduleAuto();return changes;
 },
 chooseConfig: ()=>chooseConnection(true),
 chooseCore: ()=>chooseConnection(false),
 async source(){await shell.openExternal('https://ip.net.coffee/claude/');return {};},
 async importFolder(){await shell.openPath(path.join(app.isPackaged?process.resourcesPath:__dirname,'examples'));return {};},
};
function commandArgument(){
 return '--linkbox-commands='+JSON.stringify(Object.keys(commands));
}
ipcMain.handle('linkbox',async(event,action,data)=>{
 if(event.sender!==win?.webContents||event.senderFrame!==win.webContents.mainFrame)throw Error('不允许的调用来源');
 try{
 if(quitting)throw Error('正在退出链路盒子');
 if(!Object.hasOwn(commands,action))throw Error('未知操作');
 if(DEMO){if(action==='benchmarkSettings')return {ok:true,data:commands.benchmarkSettings()};if(action==='state')return {ok:true,data:{mode:'global',tun:true,entry:'日本 JP V1-3',exit:'美国静态家宽',dialer:'中转入口',nodes:demoNodes,lastTest:new Date().toISOString(),expectedIP:'203.0.113.10',settings:{hourly:true},progress:{running:false}}};if(action==='ip')return {ok:true,data:{ip:'203.0.113.10',country:'United States',region:'California',city:'Los Angeles',asn:7018,isp:'AT&T Enterprises, LLC'}};if(action==='coffee')return {ok:true,data:{score:'100',ip:'203.0.113.10',props:{类型:'家庭住宅 IP'},dns:{结果:'未检测到泄露'},udp:{结果:'未检测到泄露'},time:new Date().toISOString()}};return {ok:true,data:{message:'预览模式不执行代理操作'}};}
 return {ok:true,data:await commands[action](data)};
 }catch(e){return {ok:false,error:safeError(e)};}
});
