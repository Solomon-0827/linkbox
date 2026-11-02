'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const {downloadArtifact}=require('@electron/get');
(async()=>{
 const root=path.resolve(__dirname,'..'),out=path.join(root,'dist'),work=path.join(root,'build/windows'),folder=path.join(work,'LinkBox-Windows-x64');
 await fs.mkdir(out,{recursive:true});await fs.mkdir(work,{recursive:true});
 const runtime=await downloadArtifact({version:'42.11.18',artifactName:'electron',platform:'win32',arch:'x64'});
 await fs.rm(folder,{recursive:true,force:true});await fs.mkdir(folder,{recursive:true});
 if(process.platform==='win32')execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Expand-Archive -LiteralPath '${runtime.replaceAll("'","''")}' -DestinationPath '${folder.replaceAll("'","''")}' -Force`]);
 else execFileSync('/usr/bin/unzip',['-q',runtime,'-d',folder]);
 const stage=path.join(work,'stage');await fs.rm(stage,{recursive:true,force:true});await fs.mkdir(stage,{recursive:true});
 for(const f of ['main.cjs','backend.cjs','preload.cjs','renderer.js','index.html','style.css','icon.png','coffee-extract.js','subscriptions.cjs','icons.js'])await fs.copyFile(path.join(__dirname,f),path.join(stage,f));
 const pkg=JSON.parse(await fs.readFile(path.join(__dirname,'package.json'),'utf8'));delete pkg.devDependencies;delete pkg.scripts;await fs.writeFile(path.join(stage,'package.json'),JSON.stringify(pkg));
 for(const dep of ['yaml','https-proxy-agent','agent-base','debug','ms'])await fs.cp(path.join(__dirname,'node_modules',dep),path.join(stage,'node_modules',dep),{recursive:true});
 const asar=await import('@electron/asar');await asar.createPackage(stage,path.join(folder,'resources','app.asar'));await fs.rm(path.join(folder,'resources','default_app.asar'),{force:true});
 await fs.rename(path.join(folder,'electron.exe'),path.join(folder,'LinkBox.exe'));
 const R=await import('resedit'),exe=R.NtExecutable.from(await fs.readFile(path.join(folder,'LinkBox.exe')),{ignoreCert:true}),res=R.NtExecutableResource.from(exe);
 const info=R.Resource.VersionInfo.fromEntries(res.entries)[0];if(info){info.setFileVersion(...pkg.version.split('.').map(Number),0);info.setProductVersion(...pkg.version.split('.').map(Number),0);info.setStringValues({lang:1033,codepage:1200},{FileDescription:'链路盒子',ProductName:'链路盒子',OriginalFilename:'LinkBox.exe',CompanyName:'Solomon-0827'});info.outputToResourceEntries(res.entries);}
 const ico=R.Data.IconFile.from(await fs.readFile(path.join(__dirname,'icon.ico')));for(const group of R.Resource.IconGroupEntry.fromEntries(res.entries))R.Resource.IconGroupEntry.replaceIconsForResource(res.entries,group.id,group.lang,ico.icons.map(x=>x.data));res.outputResource(exe);await fs.writeFile(path.join(folder,'LinkBox.exe'),Buffer.from(exe.generate()));
 await fs.cp(path.join(root,'examples'),path.join(folder,'resources/examples'),{recursive:true});await fs.copyFile(path.join(root,'README.md'),path.join(folder,'README.md'));
 const zip=path.join(out,'linkbox-windows-x64.zip');await fs.rm(zip,{force:true});
 if(process.platform==='win32')execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Compress-Archive -LiteralPath '${folder.replaceAll("'","''")}' -DestinationPath '${zip.replaceAll("'","''")}' -Force`]);
 else execFileSync('python3',['-c','import shutil,sys;shutil.make_archive(sys.argv[1][:-4],"zip",sys.argv[2],sys.argv[3])',zip,work,path.basename(folder)]);
 await fs.writeFile(zip+'.sha256',crypto.createHash('sha256').update(await fs.readFile(zip)).digest('hex')+'  '+path.basename(zip)+'\n');console.log(zip);
})().catch(e=>{console.error(e.message);process.exit(1)});
