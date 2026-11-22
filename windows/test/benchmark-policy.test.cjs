'use strict';
const assert=require('node:assert/strict'),test=require('node:test');
const policy=require('../benchmark-policy.cjs');
const samples=require('../../fixtures/benchmark-policy/samples.json');
const candidates=require('../../fixtures/benchmark-policy/candidates.json');
const guards=require('../../fixtures/benchmark-policy/switch-guards.json');

for(const {name,minimumSuccesses,probes,expected} of samples){
 test(`shared benchmark samples: ${name}`,()=>{
  const successes=probes.filter(ms=>ms!==null).map(ms=>({ms}));
  assert.equal(policy.sampleDelay(successes,minimumSuccesses),expected);
 });
}

for(const {name,results,current,metric,expected} of candidates){
 test(`shared benchmark candidate: ${name}`,()=>{
  assert.equal(policy.autoCandidate(results,current,metric),expected);
 });
}

for(const {name,mode,routingUnchanged,cancelled,allowed} of guards){
 test(`shared benchmark switch guard: ${name}`,()=>{
  const state={mode,exit:'exit',dialer:'relay'};
  const settings={autoRelay:true,metric:'chain'};
  const complete=policy.runComplete('chain',policy.stopReason('',cancelled),2,2);
  const authorized=policy.autoSwitchAuthorized(settings,settings,{settingsStable:true,revisionsMatch:true,cancelled});
  assert.equal(complete,!cancelled);
  assert.equal(authorized,!cancelled);
  assert.equal(policy.chainAllowed(state,'exit','relay')&&complete&&authorized&&
   policy.switchAllowed(routingUnchanged,true,['a'],'a'),allowed);
 });
}

test('only a finished, uninterrupted chain run can recommend a relay',()=>{
 assert.equal(policy.runComplete('chain','',2,2),true);
 assert.equal(policy.runComplete('chain','',1,2),false);
 assert.equal(policy.runComplete('chain','network changed',2,2),false);
 assert.equal(policy.runComplete('entrance','',2,2),false);
});

test('median preserves rounding up at a half millisecond',()=>{
 assert.equal(policy.sampleDelay([{ms:100},{ms:101}]),101);
});
