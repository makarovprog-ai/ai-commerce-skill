import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {install} from '../scripts/lib/install.mjs';
import {createHash,randomBytes} from 'node:crypto';
import {openSync,closeSync} from 'node:fs';
import {updateInstalled} from '../scripts/lib/update.mjs';
import {installedMetadata} from '../cli/updates.mjs';
import {main} from '../cli/app.mjs';
import {CommerceClient} from '../cli/workflow.mjs';
import {Storage} from '../cli/storage.mjs';
import {documentedInvocation} from './fixtures/invocation.mjs';
import {syntheticProtocol} from './fixtures/protocol.mjs';
import {execFile,spawnSync} from 'node:child_process';
import {promisify} from 'node:util';

async function fixture(t){
 const base=await mkdtemp(join(await realpath(tmpdir()),'commerce-upgrade-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const source=join(base,'source'),home=join(base,'home');await mkdir(home);await mkdir(source);
 const original=fileURLToPath(new URL('..',import.meta.url));
 for(const dir of ['bin','cli','skills','scripts'])await cp(join(original,dir),join(source,dir),{recursive:true});
 await writeFile(join(source,'package.json'),JSON.stringify({name:'ai-commerce-skill',version:'0.4.0',type:'module'}));
 return {base,source,home,agent:'both',origin:'git@example.test:org/repo.git',commit:'a'.repeat(40)};
}
test('broken new launcher is rejected before replacing a working registration',async t=>{
 const s=await fixture(t),first=await install(s),before=await readFile(join(first.skills[0],'SKILL.md'),'utf8');
 await writeFile(join(s.source,'package.json'),JSON.stringify({name:'ai-commerce-skill',version:'0.5.0',type:'module'}));
 await writeFile(join(s.source,'bin/ai-commerce.mjs'),'process.exit(1);\n');
 await assert.rejects(install({...s,upgrade:true}),/smoke|launch|check/i);
 assert.equal(await readFile(join(first.skills[0],'SKILL.md'),'utf8'),before);
});
test('failure on first switch leaves no stale journal and a later explicit attempt succeeds',async t=>{
 const s=await fixture(t),first=await install(s);
 await writeFile(join(s.source,'package.json'),JSON.stringify({name:'ai-commerce-skill',version:'0.5.0',type:'module'}));
 const fs=await import('node:fs/promises'),original=fs.default.rename;let failed=false;
 t.mock.method(fs.default,'rename',async(from,to)=>{if(!failed&&from===first.skills[0]){failed=true;throw Error('synthetic refusal');}return original(from,to);});
 const {syncBuiltinESMExports}=await import('node:module');syncBuiltinESMExports();
 try{await assert.rejects(install({...s,upgrade:true}));assert.equal(failed,true);}finally{t.mock.restoreAll();syncBuiltinESMExports();}
 const next=await install({...s,upgrade:true});assert.notEqual(next.directory,first.directory);
});
test('release manifest can add a runtime module without shipping arbitrary source files',async t=>{
 const s=await fixture(t);const {payload,skill}=JSON.parse(await readFile(new URL('../distribution.json',import.meta.url),'utf8').catch(()=>'{}'));
 assert.ok(Array.isArray(payload),'release payload manifest is missing');
 await writeFile(join(s.source,'distribution.json'),JSON.stringify({version:1,payload:[...payload,'cli/new-feature.mjs'],skill}));
 await writeFile(join(s.source,'cli/new-feature.mjs'),'export const ready=true;\n');
 const out=await install(s);assert.equal(await readFile(join(out.directory,'cli/new-feature.mjs'),'utf8'),'export const ready=true;\n');
 await writeFile(join(s.source,'distribution.json'),JSON.stringify({version:1,payload:[...payload,'../outside.mjs'],skill}));
 await assert.rejects(install({...s,upgrade:true}),/manifest/i);
});
test('explicit upgrade changes both registrations without touching vault and can detect user edits',async t=>{
 const s=await fixture(t),first=await install(s);
 const stateDir=join(s.base,'original private state'),passwordPath=join(s.base,'synthetic passphrase');
 await writeFile(passwordPath,randomBytes(32).toString('hex')+'\n',{flag:'wx',mode:0o600});
 const fd=openSync(passwordPath,'r');
 try{
  const store=new Storage(stateDir,'mcp',{passphraseFd:fd});
  const keys=await store.withLock(s=>s.keys(true));
  const f=syntheticProtocol({keys});
  f.advance(Math.floor(Date.now()/1000)-f.now());
  assert.equal((await new CommerceClient({...f,store}).login()).status,'active');
 }finally{closeSync(fd);}
 const vault=join(stateDir,'vault.json'),before=await readFile(vault);
 function assertStored(invocation){
  const probeFd=openSync(passwordPath,'r');
  try{
   const r=spawnSync(invocation[0],[...invocation.slice(1),'status','--profile','mcp','--state-dir',stateDir,'--passphrase-fd','3'],
    {encoding:'utf8',timeout:20000,stdio:['pipe','pipe','pipe',probeFd]});
   assert.equal(r.status,0,r.stderr||r.stdout);
   assert.equal(JSON.parse(r.stdout).data.status,'stored');
  }finally{closeSync(probeFd);}
 }
 assertStored([first.node,first.launcher]);
 await writeFile(join(s.source,'package.json'),JSON.stringify({name:'ai-commerce-skill',version:'0.5.0',type:'module'}));
 await assert.rejects(install(s),/collision/);
 const next=await install({...s,upgrade:true});assert.notEqual(next.directory,first.directory);
 for(const target of next.skills){const text=await readFile(join(target,'SKILL.md'),'utf8');assert.ok(text.includes(next.launcher.replaceAll('\\','\\\\')));}
 for(const target of next.skills)assertStored(documentedInvocation(await readFile(join(target,'SKILL.md'),'utf8')));
 assert.deepEqual(await readFile(vault),before);
 assert.ok((await readFile(first.launcher)).length>0);
 await writeFile(join(next.skills[1],'extra.md'),'user content');
 await writeFile(join(s.source,'package.json'),JSON.stringify({name:'ai-commerce-skill',version:'0.6.0',type:'module'}));
 await assert.rejects(install({...s,upgrade:true}),/modified|collision/);
 assert.deepEqual(documentedInvocation(await readFile(join(next.skills[0],'SKILL.md'),'utf8')),[next.node,next.launcher]);
});
test('installed update can sign tools/list using the existing device and session without logging in',async t=>{
 const s=await fixture(t),previous=process.env.AI_COMMERCE_TEST_PREVIOUS_SOURCE;
 const first=await install(previous?{...s,source:previous}:s),stateDir=join(s.base,'retained profile'),passphrasePath=join(s.base,'test passphrase');
 await writeFile(passphrasePath,randomBytes(32).toString('hex')+'\n',{flag:'wx',mode:0o600});
 const OldStorage=(await import(pathToFileURL(join(first.directory,'cli/storage.mjs')).href)).Storage;
 const OldClient=(await import(pathToFileURL(join(first.directory,'cli/workflow.mjs')).href)).CommerceClient;
 let f,configuredDevice,fd=openSync(passphrasePath,'r');
 try{
  const store=new OldStorage(stateDir,'mcp',{passphraseFd:fd});
  const keys=await store.withLock(v=>v.keys(true));
  f=syntheticProtocol({keys});
  f.advance(Math.floor(Date.now()/1000)-f.now());
  configuredDevice=(await new OldClient({...f,store}).login()).device_id;
 }finally{closeSync(fd);}
 const vault=join(stateDir,'vault.json'),before=await readFile(vault);
 const version=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
 await writeFile(join(s.source,'package.json'),JSON.stringify({name:'ai-commerce-skill',version,type:'module'}));
 const next=await install({...s,upgrade:true});assert.notEqual(next.directory,first.directory);
 assert.ok((await readFile(vault)).equals(before),'installer must not rewrite the vault');
 const {main:updatedMain}=await import(pathToFileURL(join(next.directory,'cli/app.mjs')).href);
 f.calls.length=0;
 const output=[];fd=openSync(passphrasePath,'r');
 try{
  const result=await updatedMain(['session','--profile','mcp','--state-dir',stateDir,'--passphrase-fd',String(fd)],{
   now:f.now,transport:f.transport,updates:{check:async()=>({status:'unavailable'})},write:line=>output.push(JSON.parse(line)),
  });
  assert.equal(result,0);
 }finally{closeSync(fd);}
 assert.equal(output.length,1);
 assert.equal(output[0].data.device_id,configuredDevice);
 assert.equal(output[0].data.provider_check,'verified');
 assert.deepEqual(f.calls.map(c=>new URL(c.url).pathname),['/sberid-auth/mcp-session','/sberid-auth/release-jwks','/mcp']);
 const headers=f.calls.at(-1).options.headers;
 assert.match(headers['ai-commerce-signature-input']??'',/^aipay=\(/);
 assert.match(headers['ai-commerce-signature']??'',/^aipay=:/);
 assert.equal(headers['signature-input'],undefined);assert.equal(headers.signature,undefined);
});
test('upgrade rollback restores first registration if second switch fails',async t=>{
 const s=await fixture(t),first=await install(s);const before=await Promise.all(first.skills.map(p=>readFile(join(p,'SKILL.md'),'utf8')));
 await writeFile(join(s.source,'package.json'),JSON.stringify({name:'ai-commerce-skill',version:'0.5.0',type:'module'}));
 const fs=await import('node:fs/promises');const original=fs.default.rename;let failed=false;
 t.mock.method(fs.default,'rename',async(from,to)=>{if(!failed&&to===first.skills[1]&&from.includes('.ai-commerce-stage-')){failed=true;throw Error('synthetic disk failure');}return original(from,to);});
 const {syncBuiltinESMExports}=await import('node:module');syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 await assert.rejects(install({...s,upgrade:true}));assert.equal(failed,true);
 for(let i=0;i<first.skills.length;i++)assert.equal(await readFile(join(first.skills[i],'SKILL.md'),'utf8'),before[i]);
});
test('unchanged pre-updater installation migrates using its original content digest',async t=>{
 const s=await fixture(t),binary=await readFile(process.execPath),hash=b=>createHash('sha256').update(b).digest('hex');
 const names=['package.json','bin/ai-commerce.mjs',...['storage','secret-store','local-key','platform-storage','crypto','http','workflow','errors','app'].map(n=>`cli/${n}.mjs`),'cli/native/windows-storage.ps1','cli/native/read-passphrase.mjs'];
 const files=new Map(names.map(name=>[name,Buffer.from(name==='package.json'?'{"name":"ai-commerce-skill","version":"0.3.0","type":"module"}\n':'export {};\n')]));
 const templates=new Map([['SKILL.md',Buffer.from('Run `{{AI_COMMERCE_COMMAND}}`\n')],['references/setup.md',Buffer.from('Setup\n')],['references/commands.md',Buffer.from('Commands\n')]]);
 const digest=createHash('sha256');for(const [n,b] of [...files,...templates])digest.update(n).update('\0').update(b).update('\0');digest.update(hash(binary));const identity=digest.digest('hex');
 const directory=join(s.home,'.local/share/ai-commerce/versions',`0.3.0-${identity.slice(0,16)}`),node=join(directory,process.platform==='win32'?'node.exe':'node'),launcher=join(directory,'launcher.mjs');
 const marker=Buffer.from(JSON.stringify({source:'ai-commerce-skill',version:'0.3.0',sha256:identity,runtime:{version:process.versions.node,sha256:hash(binary)}})+'\n');
 files.set(process.platform==='win32'?'node.exe':'node',binary);files.set('launcher.mjs',Buffer.from("await import('./bin/ai-commerce.mjs');\n"));files.set('.ai-commerce-install.json',marker);
 for(const [n,b] of files){await mkdir(join(directory,n,'..'),{recursive:true});await writeFile(join(directory,n),b);}
 for(const agent of ['.agents','.claude']){
  const target=join(s.home,agent,'skills/ai-commerce');
  for(const [n,b] of [...templates,['.ai-commerce-install.json',marker]]){await mkdir(join(target,n,'..'),{recursive:true});await writeFile(join(target,n),n==='.ai-commerce-install.json'?b:b.toString().replaceAll('{{AI_COMMERCE_COMMAND}}',JSON.stringify([node,launcher])));}
 }
 const out=await install({...s,upgrade:true});assert.notEqual(out.directory,directory);assert.equal(out.skills.length,2);
});
test('download is pinned to the discovered commit and no registrations change on mismatch',async t=>{
 const s=await fixture(t),first=await install(s),config=await installedMetadata(first.directory),before=await readFile(join(first.skills[0],'SKILL.md'),'utf8');
 const calls=[];const run=async(args)=>{calls.push(args);return args.includes('rev-parse')?'c'.repeat(40):'';};
 await assert.rejects(updateInstalled(config,{latest:async()=>({version:'0.5.0',tag:'v0.5.0',commit:'b'.repeat(40)}),run}),/changed during download/);
 assert.ok(calls.some(args=>args.includes(config.origin)));assert.ok(!calls.some(args=>args.includes('checkout')));
 assert.equal(await readFile(join(first.skills[0],'SKILL.md'),'utf8'),before);
});
test('incomplete rollback reports recovery_required and retains recovery material instead of a generic failure',async t=>{
 const s=await fixture(t),first=await install(s);
 await writeFile(join(s.source,'package.json'),JSON.stringify({name:'ai-commerce-skill',version:'0.5.0',type:'module'}));
 const fs=await import('node:fs/promises'),original=fs.default.rename;
 t.mock.method(fs.default,'rename',async(from,to)=>{
  if((to===first.skills[1]&&basename(from)==='skill')||(to===first.skills[0]&&basename(from)==='previous'))throw Error('synthetic rollback failure');
  return original(from,to);
 });
 const {syncBuiltinESMExports}=await import('node:module');syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 let failure;try{await install({...s,upgrade:true});}catch(error){failure=error;}
 assert.equal(failure?.code,'update_recovery_required');
 const values=[];assert.equal(await main(['update','install'],{write:v=>values.push(JSON.parse(v)),updates:{install:async()=>{throw failure;}}}),1);
 assert.equal(values[0].error.code,'update_failed');assert.equal(values[0].error.reason,'recovery_required');assert.equal(values[0].error.next_action,'repair_installation');
 const journal=JSON.parse(await readFile(join(s.home,'.local/share/ai-commerce/update-transaction.json'),'utf8'));
 assert.ok((await readFile(join(journal[0].backup,'SKILL.md'))).length>0);
 assert.ok(!JSON.stringify(values).includes('synthetic rollback'));
});
test('download and update complete through real Git in a disposable local repository',async t=>{
 const execute=promisify(execFile);
 try{await execute('git',['--version']);}catch{t.skip('Git is unavailable');return;}
 const s=await fixture(t),first=await install(s),config=await installedMetadata(first.directory);
 await writeFile(join(s.source,'package.json'),JSON.stringify({name:'ai-commerce-skill',version:'0.5.0',type:'module'}));
 const git=async(args,cwd=s.source)=>(await execute('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=Fixture','-c','user.email=fixture@example.test',...args],{cwd,encoding:'utf8',timeout:30000})).stdout;
 await git(['init','--quiet']);await git(['add','.']);await git(['commit','--quiet','-m','synthetic release']);await git(['tag','v0.5.0']);const commit=(await git(['rev-parse','HEAD'])).trim();
 // The seam maps only the network boundary to a fixture; production rejects file remotes.
 const run=(args,{cwd,timeout}={})=>git(args.map(a=>a===config.origin?s.source:a),cwd??s.base);
 const result=await updateInstalled(config,{latest:async()=>({version:'0.5.0',tag:'v0.5.0',commit}),run});
 assert.equal(result.status,'updated');assert.equal(JSON.parse(await readFile(join(result.directory,'package.json'),'utf8')).version,'0.5.0');
 for(const target of result.skills)assert.deepEqual(documentedInvocation(await readFile(join(target,'SKILL.md'),'utf8')),[result.node,result.launcher]);
});
