const {contextBridge,ipcRenderer}=require('electron');
// Sandboxed preloads cannot load local modules. The main process supplies its command list.
const prefix='--linkbox-commands=';
const argument=process.argv.find(value=>value.startsWith(prefix));
const allowed=new Set(argument?JSON.parse(argument.slice(prefix.length)):[]);
contextBridge.exposeInMainWorld('linkbox',{call:(action,data)=>{if(!allowed.has(action))throw Error('不支持的操作');return ipcRenderer.invoke('linkbox',action,data)},onProgress:fn=>{ipcRenderer.on('progress',(_,v)=>fn(v))},onAutomatic:fn=>ipcRenderer.on('automatic',(_,v)=>fn(v))});
