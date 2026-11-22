'use strict';
const {isIP}=require('node:net');

const integer=(min,max)=>({min,max,valid:value=>Number.isInteger(value)&&value>=min&&value<=max});
const boolean={valid:value=>typeof value==='boolean'};
const invalidSettings='无效动态测速设置';
const benchmarkFields={
 hourly:{default:true,...boolean},
 interval:{default:60,...integer(1,1440),error:'测速间隔须为 1–1440 分钟。'},
 concurrency:{default:5,...integer(1,10),error:'并发测速量须为 1–10 条。'},
 autoRelay:{default:false,...boolean},
 metric:{default:'chain',valid:value=>value==='chain'||value==='entrance'},
};
const pathFields={
 configDir:{default:'',valid:value=>typeof value==='string'},
 corePath:{default:'',valid:value=>typeof value==='string'},
};
const writable={...benchmarkFields,...pathFields};
const limits=Object.fromEntries(Object.entries(benchmarkFields)
 .filter(([,field])=>field.min!==undefined).map(([key,{min,max}])=>[key,{min,max}]));

function benchmarkSettings(values){
 return Object.fromEntries(Object.entries(benchmarkFields)
  .map(([key,field])=>[key,field.valid(values?.[key])?values[key]:field.default]));
}

function expectedIP(override, configured=''){
 const empty=override && typeof override==='object' && !Object.keys(override).length;
 const value=empty?configured:override||configured;
 if(typeof value!=='string')return '';
 const [address,scope,...extra]=value.split('%');
 const family=isIP(address);
 if(family===4&&scope===undefined)return address;
 if(family!==6||extra.length||scope==='')return '';
 const canonical=new URL('http://['+address+']').hostname.slice(1,-1);
 return scope===undefined?canonical:canonical+'%'+scope;
}

function storedSettings(values){
 const saved=values&&typeof values==='object'&&!Array.isArray(values)?values:{};
 return {...saved,...benchmarkSettings(saved),...Object.fromEntries(Object.entries(pathFields)
  .map(([key,field])=>[key,field.valid(saved[key])?saved[key]:field.default]))};
}

function settingChanges(values){
 return Object.fromEntries(Object.entries(writable).filter(([key])=>Object.hasOwn(values,key)).map(([key,field])=>{
  if(!field.valid(values[key]))throw Error(field.error||invalidSettings);
  return [key,values[key]];
 }));
}

function benchmarkChanges(values){
 if(typeof values?.hourly==='boolean')return {hourly:values.hourly};
 return settingChanges(Object.fromEntries(Object.keys(benchmarkFields).filter(key=>key!=='hourly')
  .map(key=>[key,values?.[key]])));
}

module.exports={benchmarkSettings,expectedIP,storedSettings,settingChanges,benchmarkChanges,limits};
