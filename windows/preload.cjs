const {contextBridge,ipcRenderer}=require('electron');
const allowed=new Set(['state','ip','coffee','switch','benchmark','cancel','update','check','downloadReport','catalog','saveSelection','removeNodes','activity','choosePolicy','copyIP','settings','chooseConfig','chooseCore','source','importFolder']);
contextBridge.exposeInMainWorld('linkbox',{call:(action,data)=>{if(!allowed.has(action))throw Error('不支持的操作');return ipcRenderer.invoke('linkbox',action,data)},onProgress:fn=>{ipcRenderer.on('progress',(_,v)=>fn(v))},onAutomatic:fn=>ipcRenderer.on('automatic',(_,v)=>fn(v))});
