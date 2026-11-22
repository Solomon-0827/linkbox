'use strict';
const {isDeepStrictEqual}=require('node:util');

const PARAMETERS=Object.freeze({
 chainModes:Object.freeze(['global']),
 metrics:Object.freeze(['chain','entrance']),
 defaultMetric:'chain',
 intervalDefaultMinutes:60,
 intervalRangeMinutes:Object.freeze([1,1440]),
 concurrencyDefault:5,
 concurrencyRange:Object.freeze([1,10]),
 entranceTimeoutMs:8000,
 traceTimeoutMs:8000,
 entranceProbes:1,
 chainProbes:3,
 chainMinSuccesses:2,
 probePauseMs:100,
 guardIntervalMs:2500,
 powershellTimeoutMs:12000,
 startupAttempts:40,
 startupPollMs:100,
 childStopMs:1800,
 improvementMs:20,
 improvementFraction:.10,
});

function chainAllowed(state,expectedExit,expectedDialer){
 return PARAMETERS.chainModes.includes(state.mode)&&state.exit===expectedExit&&state.dialer===expectedDialer;
}

function stopAfterProbeFailure(samples){
 return !samples.length;
}

function sampleDelay(samples,minimum=PARAMETERS.chainMinSuccesses){
 if(samples.length<minimum)return null;
 const times=samples.map(sample=>sample.ms).sort((a,b)=>a-b);
 return Math.round((times[Math.floor((times.length-1)/2)]+times[Math.floor(times.length/2)])/2);
}

function stopReason(reason,cancelled){
 return reason||(cancelled?'手动停止':'');
}

function runComplete(kind,reason,completed,total){
 return kind==='chain'&&!reason&&completed===total;
}

function autoCandidate(results,current,metric){
 if(!Object.hasOwn(results,current))return null;
 const key=metric==='entrance'?'entranceDelay':'chainDelay';
 const valid=value=>Number.isInteger(value)&&value>0;
 const eligible=Object.entries(results).filter(([name,row])=>name!==current&&valid(row.chainDelay)&&valid(row[key]));
 const best=eligible.sort(([a,x],[b,y])=>x[key]-y[key]||(a<b?-1:1))[0];
 if(!best)return null;
 const currentRow=results[current],baseline=currentRow[key];
 if(!valid(currentRow.chainDelay))return best[0];
 if(valid(baseline)&&baseline-best[1][key]>=Math.max(PARAMETERS.improvementMs,baseline*PARAMETERS.improvementFraction))return best[0];
 return null;
}

function isMetric(value){
 return PARAMETERS.metrics.includes(value);
}

function autoSwitchAuthorized(options,settings,{settingsStable,revisionsMatch,cancelled}){
 return settingsStable&&options.autoRelay&&settings.autoRelay===true&&
  (isMetric(settings.metric)?settings.metric:PARAMETERS.defaultMetric)===options.metric&&
  settings.hourly!==false&&revisionsMatch&&!cancelled;
}

function signature(state){
 return JSON.stringify([state.mode,state.tun,state.entry,state.exit,state.dialer,[...new Set(state.live)].sort()]);
}

function sameRouting(probe,fresh,current,target){
 return fresh?.nodes.has(target)&&isDeepStrictEqual(
  [probe.nodes.get(current),probe.nodes.get(target),probe.exit,probe.dnsPolicy,probe.expectedIP],
  [fresh.nodes.get(current),fresh.nodes.get(target),fresh.exit,fresh.dnsPolicy,fresh.expectedIP]);
}

function switchAllowed(routingUnchanged,stateUnchanged,live,target){
 return routingUnchanged&&stateUnchanged&&live.includes(target);
}

function targetOwnerMatches(state,target,owner){
 return state.switchable.includes(target)&&state.entryOwners[target]===owner;
}

function switchVerified(after,before,target,owner){
 return after.entry===target&&after.mode===before.mode&&after.tun===before.tun&&
  after.exit===before.exit&&after.dialer===before.dialer&&targetOwnerMatches(after,target,owner);
}

module.exports={PARAMETERS,isMetric,chainAllowed,stopAfterProbeFailure,sampleDelay,stopReason,runComplete,autoCandidate,
 autoSwitchAuthorized,signature,sameRouting,switchAllowed,targetOwnerMatches,switchVerified};
