'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),test=require('node:test');
const {benchmarkSettings,benchmarkChanges,storedSettings,expectedIP}=require('../preferences.cjs');
const {mergeSelectionDraft}=require('../subscriptions.cjs');
const fixtures=path.join(__dirname,'../../fixtures');

for(const name of fs.readdirSync(path.join(fixtures,'settings')).filter(name=>name.endsWith('.json'))){
 test('shared settings '+name,()=>{
  const {input,configuredIP,output,error}=require(path.join(fixtures,'settings',name));
  if(error){
   assert.throws(()=>benchmarkChanges(input),{message:error});
   return;
  }
  const saved=storedSettings(input);
  assert.deepEqual({...benchmarkSettings(saved),expectedIP:expectedIP(saved.expectedIP,configuredIP)},output);
 });
}

test('Windows connection preferences preserve valid paths and reject invalid changes',()=>{
 const {settingChanges}=require('../preferences.cjs');
 const saved=storedSettings({configDir:'fixture-config',corePath:42});
 assert.equal(saved.configDir,'fixture-config');
 assert.equal(saved.corePath,'');
 assert.throws(()=>settingChanges({corePath:42}),/无效动态测速设置/);
 assert.deepEqual(settingChanges({corePath:'fixture-core.exe',expectedIP:'203.0.113.10'}),{corePath:'fixture-core.exe'});
});

test('draft refresh preserves catalog order and explicit owner',()=>{
 const {catalog,changes,output}=require(path.join(fixtures,'selection-draft/refresh.json'));
 const before=structuredClone(catalog);
 assert.deepEqual(mergeSelectionDraft(catalog,changes),output);
 assert.deepEqual(catalog,before);
});
