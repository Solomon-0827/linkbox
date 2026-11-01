'use strict';
const {app,BrowserWindow,ipcMain,Tray,Menu,nativeImage,shell,dialog,session,nativeTheme}=require('electron');
const path=require('node:path'),fs=require('node:fs/promises');
const {Backend,writeJSON,safeError}=require('./backend.cjs');
const DEMO=process.argv.includes('--demo');let win,tray,backend,quitting=false,timer,autoStarted=false,coffeeWindow,coffeePending;
app.setName('链路盒子');nativeTheme.themeSource='light';if(process.platform==='win32')app.setAppUserModelId('local.linkbox.windows');
if(!app.requestSingleInstanceLock()){app.quit();}else{
app.on('second-instance',()=>{win?.show();win?.focus()});
app.on('window-all-closed',()=>{});
app.on('before-quit',event=>{if(!quitting){event.preventDefault();quitting=true;clearInterval(timer);backend?.shutdown().finally(()=>app.quit());}});
app.whenReady().then(async()=>{
 backend=await new Backend(app.getPath('userData'),(name,data)=>win?.webContents.send(name,data)).init();
 win=new BrowserWindow({width:1150,height:850,minWidth:900,minHeight:650,show:false,title:'链路盒子',backgroundColor:'#f5f7fa',icon:path.join(__dirname,'icon.png'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}});
 win.removeMenu();win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',(e)=>e.preventDefault());
 session.defaultSession.setPermissionRequestHandler((_wc,_p,cb)=>cb(false));
 win.on('close',e=>{if(!quitting){e.preventDefault();win.hide();}});await win.loadFile('index.html');win.show();
 tray=new Tray(nativeImage.createFromPath(path.join(__dirname,'icon.png')).resize({width:32,height:32}));tray.setToolTip('链路盒子 · 后台运行');tray.setContextMenu(Menu.buildFromTemplate([{label:'打开链路盒子',click:()=>win.show()},{label:'停止测速',click:()=>backend.cancel()},{type:'separator'},{label:'退出链路盒子',click:()=>app.quit()}]));tray.on('double-click',()=>win.show());
 async function auto(){if(DEMO||backend.settings.hourly===false||backend.busy)return;try{await backend.benchmark('chain');win.webContents.send('automatic',{ok:true});}catch(e){win.webContents.send('automatic',{error:safeError(e)});}}
 timer=setInterval(auto,3600000);
 if(!DEMO)setTimeout(async()=>{try{const s=await backend.state();backend.assertChain(s);autoStarted=true;await auto();}catch{}},12000);
});
}
async function coffee(){if(coffeePending)return coffeePending;coffeePending=(async()=>{
 const s=await backend.state(),ses=session.fromPartition('netcoffee');await ses.setProxy({proxyRules:`http=127.0.0.1:${s.mixedPort};https=127.0.0.1:${s.mixedPort}`,proxyBypassRules:'<-loopback>'});
 ses.setPermissionRequestHandler((_w,_p,cb)=>cb(false));coffeeWindow=new BrowserWindow({show:false,webPreferences:{session:ses,nodeIntegration:false,contextIsolation:true,sandbox:true}});coffeeWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 const code=await fs.readFile(path.join(__dirname,'coffee-extract.js'),'utf8');let last={};try{await coffeeWindow.loadURL('https://ip.net.coffee/claude/');const until=Date.now()+45000;while(Date.now()<until){last=await coffeeWindow.webContents.executeJavaScript(code);if(/^\d+$/.test(last.score)&&last.ip&&Object.values(last.udp||{}).some(Boolean)&&Object.values(last.dns||{}).some(Boolean))break;await new Promise(r=>setTimeout(r,1500));}return {...last,time:new Date().toISOString()};}finally{coffeeWindow?.destroy();coffeeWindow=null;}})();try{return await coffeePending;}finally{coffeePending=null;}}
const demoNodes=['日本 JP V1-3','香港 HK 01','新加坡 SG 02','日本 JP V1-2','美国新 ISP A1','香港 HK 02'].map((name,i)=>({name,provider:i%2?'mmti':'Neko',delay:[286,312,349,422,null,518][i],status:i===4?'failed':'done',kind:'chain'}));
ipcMain.handle('linkbox',async(event,action,data)=>{
 if(event.sender!==win?.webContents||event.senderFrame!==win.webContents.mainFrame)throw Error('不允许的调用来源');
 try{
 if(DEMO){if(action==='state')return {ok:true,data:{mode:'global',tun:true,entry:'日本 JP V1-3',exit:'美国静态家宽',dialer:'中转入口',nodes:demoNodes,lastTest:new Date().toISOString(),expectedIP:'203.0.113.10',settings:{hourly:true},progress:{running:false}}};if(action==='ip')return {ok:true,data:{ip:'203.0.113.10',country:'United States',region:'California',city:'Los Angeles',asn:7018,isp:'AT&T Enterprises, LLC'}};if(action==='coffee')return {ok:true,data:{score:'100',ip:'203.0.113.10',props:{类型:'家庭住宅 IP'},dns:{结果:'未检测到泄露'},udp:{结果:'未检测到泄露'},time:new Date().toISOString()}};return {ok:true,data:{message:'预览模式不执行代理操作'}};}
 let value;switch(action){
 case 'state':value=await backend.state();break;
 case 'ip':value=await backend.ipInfo();break;
 case 'coffee':value=await coffee();break;
 case 'switch':if(typeof data?.name!=='string'||typeof data?.previous!=='string')throw Error('无效节点');value=await backend.switchNode(data.name,data.previous);break;
 case 'benchmark':value=await backend.benchmark(data);break;
 case 'cancel':backend.cancel();value={};break;
 case 'update':value=await backend.updateSubscriptions();break;
 case 'check':value=await backend.networkCheck();break;
 case 'saveBrowserCheck':if(JSON.stringify(data).length>60000)throw Error('检查报告过大');await writeJSON(path.join(backend.dataDir,'browser-check.json'),data);value={};break;
 case 'settings':await backend.saveSettings({hourly:!!data?.hourly});value={};break;
 case 'chooseConfig':case 'chooseCore':{const dir=action==='chooseConfig';const r=await dialog.showOpenDialog(win,{title:dir?'选择 Clash Verge 配置目录':'选择 verge-mihomo.exe',properties:[dir?'openDirectory':'openFile'],...(dir?{}:{filters:[{name:'Mihomo 内核',extensions:['exe']}]})});if(!r.canceled)await backend.saveSettings({[dir?'configDir':'corePath']:r.filePaths[0]});value={};break;}
 case 'reports':await fs.mkdir(path.join(backend.dataDir),{recursive:true});await shell.openPath(backend.dataDir);value={};break;
 case 'source':await shell.openExternal('https://ip.net.coffee/claude/');value={};break;
 case 'importFolder':await shell.openPath(path.join(app.isPackaged?process.resourcesPath:__dirname,'examples'));value={};break;
 case 'choosePolicy':{if(backend.busy)throw Error('请等待测速完成');const r=await dialog.showOpenDialog(win,{title:'导入节点筛选规则',properties:['openFile'],filters:[{name:'JSON',extensions:['json']}]});if(!r.canceled){const file=r.filePaths[0];if((await fs.stat(file)).size>1024*1024)throw Error('文件过大');const p=JSON.parse(await fs.readFile(file,'utf8'));if(!p||typeof p!=='object'||!Array.isArray(p.blocked_providers)||!p.excluded_nodes||typeof p.excluded_nodes!=='object')throw Error('无效筛选规则');await writeJSON(path.join(backend.dataDir,'node-policy.json'),p);}value={};break;}
 default:throw Error('未知操作');}
 return {ok:true,data:value};
 }catch(e){return {ok:false,error:safeError(e)};}
});
