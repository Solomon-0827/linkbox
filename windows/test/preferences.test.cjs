'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),test=require('node:test');
const {benchmarkSettings,benchmarkChanges,expectedIP,settingChanges}=require('../preferences.cjs');
const {mergeSelectionDraft}=require('../subscriptions.cjs');
const fixtures=path.join(__dirname,'../../fixtures');

for(const name of fs.readdirSync(path.join(fixtures,'settings')).filter(name=>name.endsWith('.json'))){
 test('shared settings '+name,()=>{
  const {input,configuredIP,windowsExpectedIP,output,error}=require(path.join(fixtures,'settings',name));
  if(error){
   assert.throws(()=>benchmarkChanges(input),{message:error});
   return;
  }
  assert.deepEqual({...benchmarkSettings(input),expectedIP:expectedIP(input.expectedIP,configuredIP)},
   {...output,expectedIP:windowsExpectedIP??output.expectedIP});
 });
}

test('Windows connection preferences validate new path changes',()=>{
 assert.throws(()=>settingChanges({corePath:42}),/无效动态测速设置/);
 assert.deepEqual(settingChanges({corePath:'fixture-core.exe',expectedIP:'203.0.113.10'}),{corePath:'fixture-core.exe'});
});

for(const name of ['refresh.json','exact-relay-names.json']){
 test('shared selection draft '+name,()=>{
  const {catalog,changes,output}=require(path.join(fixtures,'selection-draft',name));
  const before=structuredClone(catalog);
  assert.deepEqual(mergeSelectionDraft(catalog,changes),output);
  assert.deepEqual(catalog,before);
 });
}
