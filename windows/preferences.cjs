'use strict';
const {isIP}=require('node:net');
const {PARAMETERS,isMetric}=require('./benchmark-policy.cjs');

const integer=(min,max)=>({valid:value=>Number.isInteger(value)&&value>=min&&value<=max});
const boolean={valid:value=>typeof value==='boolean'};
const invalidSettings='无效动态测速设置';
const benchmarkFields={
 hourly:{default:true,...boolean},
 interval:{default:PARAMETERS.intervalDefaultMinutes,...integer(...PARAMETERS.intervalRangeMinutes),error:'测速间隔须为 1–1440 分钟。'},
 concurrency:{default:PARAMETERS.concurrencyDefault,...integer(...PARAMETERS.concurrencyRange),error:'并发测速量须为 1–10 条。'},
 autoRelay:{default:false,...boolean},
 metric:{default:PARAMETERS.defaultMetric,valid:isMetric},
};
const pathFields={
 configDir:{valid:value=>typeof value==='string'},
 corePath:{valid:value=>typeof value==='string'},
};
const writable={...benchmarkFields,...pathFields};

function benchmarkSettings(values){
 return Object.fromEntries(Object.entries(benchmarkFields)
  .map(([key,field])=>[key,field.valid(values?.[key])?values[key]:field.default]));
}

function expectedIP(override, configured=''){
 return override||(isIP(configured)?configured:'');
}

function settingChanges(values){
 return Object.fromEntries(Object.entries(writable).filter(([key])=>Object.hasOwn(values,key)).map(([key,field])=>{
  if(!field.valid(values[key]))throw Error(field.error||invalidSettings);
  return [key,values[key]];
 }));
}

function benchmarkChanges(values){
 if(typeof values?.hourly==='boolean')return {hourly:values.hourly};
 const {interval,concurrency,autoRelay,metric}=values??{};
 return settingChanges({interval:decimalInput(interval),concurrency:decimalInput(concurrency),autoRelay,metric});
}

function decimalInput(value){
 if(typeof value!=='string')return value;
 // Match the macOS sheet's whitespace trimming and decimal Int input.
 const trimmed=value.replace(/^[\p{Zs}\t\u200b]+|[\p{Zs}\t\u200b]+$/gu,'');
 return /^[+-]?[0-9]+$/.test(trimmed)?Number(trimmed):value;
}

module.exports={benchmarkSettings,expectedIP,settingChanges,benchmarkChanges};
