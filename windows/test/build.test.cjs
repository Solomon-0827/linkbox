'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),test=require('node:test');
const {execFileSync}=require('node:child_process');
const {checkPackage,stageApp}=require('../build.cjs');

function zip(work,root,name){
 const archive=path.join(work,name+'.zip');
 if(process.platform==='win32')execFileSync('tar.exe',['-a','-cf',archive,'-C',work,root]);
 else execFileSync('zip',['-qr',archive,root],{cwd:work});
 return archive;
}

test('the Windows ZIP must include LinkBox.exe and coffee-extract.js in app.asar',async t=>{
 const work=await fs.mkdtemp(path.join(os.tmpdir(),'linkbox-test-package-'));
 t.after(()=>fs.rm(work,{recursive:true,force:true}));
 const root='LinkBox-Windows-x64',folder=path.join(work,root),stage=path.join(work,'stage');
 await fs.mkdir(path.join(folder,'resources'),{recursive:true});
 await fs.mkdir(stage);
 await fs.writeFile(path.join(stage,'main.cjs'),'// package fixture');
 const asar=await import('@electron/asar');
 await asar.createPackage(stage,path.join(folder,'resources/app.asar'));

 await assert.rejects(checkPackage(zip(work,root,'missing-exe'),root,[]),{message:'Missing required ZIP entry: LinkBox.exe'});
 await fs.writeFile(path.join(folder,'LinkBox.exe'),'fixture exe');
 await assert.rejects(checkPackage(zip(work,root,'missing-coffee'),root,[]),{message:'Missing app.asar entry: coffee-extract.js'});
});

test('the Windows ZIP rejects an archive missing a staged dependency file',async t=>{
 const work=await fs.mkdtemp(path.join(os.tmpdir(),'linkbox-test-package-'));
 t.after(()=>fs.rm(work,{recursive:true,force:true}));
 const root='LinkBox-Windows-x64',folder=path.join(work,root),stage=path.join(work,'stage');
 await fs.mkdir(path.join(folder,'resources'),{recursive:true});
 await fs.writeFile(path.join(folder,'LinkBox.exe'),'fixture exe');
 const {stagedFiles}=await stageApp(stage);
 const asar=await import('@electron/asar');
 const archive=path.join(folder,'resources/app.asar');
 await asar.createPackage(stage,archive);
 await checkPackage(zip(work,root,'complete'),root,stagedFiles);

 const missing='node_modules/yaml/dist/compose/composer.js';
 await fs.unlink(path.join(stage,missing));
 await asar.createPackage(stage,archive);
 await assert.rejects(checkPackage(zip(work,root,'incomplete'),root,stagedFiles),{
  message:'Missing app.asar entry: '+missing,
 });
});
