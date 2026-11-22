'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const {downloadArtifact}=require('@electron/get');
const electronVersion=require('electron/package.json').version;
const checksums=require('electron/checksums.json');
const appFiles=['main.cjs','backend.cjs','clash.cjs','preload.cjs','renderer.js','index.html','style.css','icon.png','coffee-extract.js','subscriptions.cjs','reconcile.cjs','icons.js','preferences.cjs','ip-address.js'];
const requiredZipEntries=['LinkBox.exe','resources/app.asar'];
const requiredAppEntries=[
 'coffee-extract.js','package.json','main.cjs','preload.cjs','backend.cjs','clash.cjs','preferences.cjs',
 'subscriptions.cjs','reconcile.cjs','index.html','renderer.js','ip-address.js','icons.js','style.css','icon.png',
 'node_modules/yaml/package.json','node_modules/yaml/dist/index.js',
 'node_modules/https-proxy-agent/package.json','node_modules/https-proxy-agent/dist/index.js',
 'node_modules/agent-base/package.json','node_modules/agent-base/dist/index.js',
 'node_modules/debug/package.json','node_modules/debug/src/index.js',
 'node_modules/ms/package.json','node_modules/ms/index.js',
];

async function stageApp(stage){
 await fs.rm(stage,{recursive:true,force:true});await fs.mkdir(stage,{recursive:true});
 for(const f of appFiles)await fs.copyFile(path.join(__dirname,f),path.join(stage,f));
 const pkg=JSON.parse(await fs.readFile(path.join(__dirname,'package.json'),'utf8'));delete pkg.devDependencies;delete pkg.scripts;await fs.writeFile(path.join(stage,'package.json'),JSON.stringify(pkg));
 for(const dep of ['yaml','https-proxy-agent','agent-base','debug','ms'])await fs.cp(path.join(__dirname,'node_modules',dep),path.join(stage,'node_modules',dep),{recursive:true});
 const entries=await fs.readdir(stage,{recursive:true,withFileTypes:true});
 const stagedFiles=entries.filter(entry=>!entry.isDirectory()).map(entry=>
  path.relative(stage,path.join(entry.parentPath,entry.name)).split(path.sep).join('/'));
 return {pkg,stagedFiles};
}

async function checkPackage(zip,zipRoot,stagedFiles){
 const onWindows=process.platform==='win32';
 const listing=onWindows?execFileSync('tar.exe',['-tf',zip]):execFileSync('/usr/bin/unzip',['-Z1',zip]);
 const entries=new Set(listing.toString().split(/\r?\n/));
 for(const file of requiredZipEntries){
  if(!entries.has(zipRoot+'/'+file))throw Error('Missing required ZIP entry: '+file);
 }
 const folder=await fs.mkdtemp(path.join(path.dirname(zip),'.linkbox-package-'));
 try{
  const archive=path.join(folder,'app.asar'),entry=zipRoot+'/resources/app.asar';
  const output=await fs.open(archive,'w');
  try{
   const options={stdio:['ignore',output.fd,'pipe']};
   if(onWindows)execFileSync('tar.exe',['-xOf',zip,entry],options);
   else execFileSync('/usr/bin/unzip',['-p',zip,entry],options);
  }finally{await output.close();}
  const asar=await import('@electron/asar');
  for(const file of new Set([...requiredAppEntries,...stagedFiles])){
   let entry;
   // @electron/asar resolves nested entries with native separators on Windows.
   try{entry=asar.statFile(archive,file.split('/').join(path.sep));}
   catch{throw Error('Missing app.asar entry: '+file);}
   if(entry.unpacked||!('size' in entry))throw Error('Not packed as an app.asar file: '+file);
   if(requiredAppEntries.includes(file)&&!entry.size)throw Error('Empty required app.asar entry: '+file);
  }
 }finally{await fs.rm(folder,{recursive:true,force:true});}
}

async function build(){
 const root=path.resolve(__dirname,'..'),out=path.join(root,'dist'),work=path.join(root,'build/windows'),folder=path.join(work,'LinkBox-Windows-x64');
 await fs.mkdir(out,{recursive:true});await fs.mkdir(work,{recursive:true});
 const runtime=await downloadArtifact({version:electronVersion,checksums,artifactName:'electron',platform:'win32',arch:'x64'});
 await fs.rm(folder,{recursive:true,force:true});await fs.mkdir(folder,{recursive:true});
 // Use Windows' bundled bsdtar to avoid PowerShell Archive module overload differences.
 if(process.platform==='win32')execFileSync('tar.exe',['-xf',runtime,'-C',folder]);
 else execFileSync('/usr/bin/unzip',['-q',runtime,'-d',folder]);
 const stage=path.join(work,'stage'),{pkg,stagedFiles}=await stageApp(stage);
 const asar=await import('@electron/asar'),archive=path.join(folder,'resources','app.asar');
 await asar.createPackage(stage,archive);await fs.rm(path.join(folder,'resources','default_app.asar'),{force:true});
 await fs.rename(path.join(folder,'electron.exe'),path.join(folder,'LinkBox.exe'));
 const R=await import('resedit'),exe=R.NtExecutable.from(await fs.readFile(path.join(folder,'LinkBox.exe')),{ignoreCert:true}),res=R.NtExecutableResource.from(exe);
 const info=R.Resource.VersionInfo.fromEntries(res.entries)[0];if(info){info.setFileVersion(...pkg.version.split('.').map(Number),0);info.setProductVersion(...pkg.version.split('.').map(Number),0);info.setStringValues({lang:1033,codepage:1200},{FileDescription:'链路盒子',ProductName:'链路盒子',OriginalFilename:'LinkBox.exe',CompanyName:'Solomon-0827'});info.outputToResourceEntries(res.entries);}
 const ico=R.Data.IconFile.from(await fs.readFile(path.join(__dirname,'icon.ico')));for(const group of R.Resource.IconGroupEntry.fromEntries(res.entries))R.Resource.IconGroupEntry.replaceIconsForResource(res.entries,group.id,group.lang,ico.icons.map(x=>x.data));res.outputResource(exe);await fs.writeFile(path.join(folder,'LinkBox.exe'),Buffer.from(exe.generate()));
 await fs.cp(path.join(root,'examples'),path.join(folder,'resources/examples'),{recursive:true});await fs.copyFile(path.join(root,'README.md'),path.join(folder,'README.md'));
 if(!(await fs.stat(path.join(folder,'LinkBox.exe'))).size)throw Error('Missing or empty LinkBox.exe');
 const zipName='linkbox-windows-x64.zip',zip=path.join(work,zipName),zipRoot=path.basename(folder);
 await fs.rm(zip,{force:true});
 if(process.platform==='win32')execFileSync('tar.exe',['-a','-cf',zip,'-C',work,path.basename(folder)]);
 else execFileSync('python3',['-c','import shutil,sys;shutil.make_archive(sys.argv[1][:-4],"zip",sys.argv[2],sys.argv[3])',zip,work,zipRoot]);
 await checkPackage(zip,zipRoot,stagedFiles);
 const checksum=crypto.createHash('sha256').update(await fs.readFile(zip)).digest('hex');
 const output=path.join(out,zipName);
 await fs.rename(zip,output);
 await fs.writeFile(output+'.sha256',checksum+'  '+zipName+'\n');
 console.log(output);
}

if(require.main===module)build().catch(e=>{console.error(e.message);process.exit(1)});
module.exports={checkPackage,stageApp};
