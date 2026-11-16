import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable,PassThrough} from 'node:stream';
import {mkdtemp,writeFile,rm,symlink,rename,realpath,mkdir} from 'node:fs/promises';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import childProcess from 'node:child_process';
import {EventEmitter} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {main,readRaw} from '../cli/app.mjs';
import {syntheticProtocol} from './fixtures/protocol.mjs';
test('help and doctor are versioned offline output; malformed argv never accesses transport',async()=>{
 const values=[];const dependencies={write:value=>values.push(JSON.parse(value)),transport:()=>{throw Error('network used');}};
 assert.equal(await main(['--help'],dependencies),0);assert.equal(values[0].version,1);assert.equal(values[0].ok,true);assert.match(values[0].data.usage,/ai-commerce/);
 assert.equal(await main(['doctor'],dependencies),0);assert.equal(values[1].data.network,'not_checked');assert.equal(values[1].data.runtime.node,process.versions.node);
 assert.equal(await main(['--version'],dependencies),0);assert.equal(values.at(-1).data.version,JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8')).version);
 for(const args of [['mcp','--url','https://wrong.test'],['login','--profile','bad'],['mcp','--input','-','--input','-'],['status','--access-token','secret'],['login','--passphrase-fd','0'],['login','--passphrase-fd','sensitive']]){assert.equal(await main(args,dependencies),1);assert.equal(values.at(-1).error.code,'usage');}
 assert.equal(await main(['doctor','--passphrase-fd','3'],dependencies),0);
});
test('failed update checks are invisible to shopping but explicit installation failures are reported',async()=>{
 const f=syntheticProtocol();await main(['login'],{...f,write:()=>{}});const values=[];let checks=0,installs=0;
 const updates={async check(){checks++;throw Error('secret remote detail');},async install(){installs++;throw Error('secret credential');}};
 const deps={...f,updates,write:v=>values.push(JSON.parse(v))};
 assert.equal(await main(['tools'],deps),0);assert.equal(values.at(-1).ok,true);assert.equal(values.at(-1).notices,undefined);assert.equal(checks,1);
 const before=f.calls.length;assert.equal(await main(['update','check'],deps),0);assert.deepEqual(values.at(-1),{version:1,ok:true,data:{status:'unavailable'}});
 assert.equal(await main(['update','install'],deps),1);assert.equal(values.at(-1).error.code,'update_failed');assert.equal(installs,1);assert.equal(f.calls.length,before);
 assert.equal(await main(['status'],deps),0);assert.equal(checks,2);
 assert.ok(!JSON.stringify(values).includes('secret remote'));assert.ok(!JSON.stringify(values).includes('secret credential'));
});
test('updated and up-to-date responses end the update with authorization untouched, without opening custody',async()=>{
 for(const state of [{status:'updated',version:'0.4.5'},{status:'up_to_date',current_version:'0.4.5'}]){
  const values=[];let installCalls=0;
  const deps={
   updates:{async install(){installCalls++;return state;}},
   get store(){assert.fail('custody accessed');},
   get transport(){assert.fail('authorization transport accessed');},
   write:v=>values.push(JSON.parse(v)),
  };
  assert.equal(await main(['update','install'],deps),0);
  assert.equal(installCalls,1);
  assert.equal(values.length,1);
  assert.equal(values[0].data.status,state.status);
  assert.equal(values[0].data.authorization,'unchanged');
  assert.equal(values[0].event,undefined);
  assert.equal(values[0].data.next_action,undefined);
 }
});
test('CLI login progress, tools and MCP output never expose protocol secrets',async()=>{
 const f=syntheticProtocol(),values=[];const deps={...f,write:v=>values.push(JSON.parse(v))};
 assert.equal(await main(['login'],deps),0);assert.equal(values[0].data.user_code,'A2B3');assert.equal(values[0].event,'login_required');assert.equal(values.at(-1).data.status,'active');
 assert.equal(await main(['tools'],deps),0);assert.equal(JSON.parse(f.calls.at(-1).options.body).method,'tools/list');
 assert.equal(await main(['mcp'],{...deps,input:Readable.from([Buffer.from(' {"method":"unknown"}\n')])}),0);assert.equal(f.calls.at(-1).options.body.toString(),' {"method":"unknown"}\n');
 const output=JSON.stringify(values);assert.ok(!output.includes(f.state.access_token));assert.ok(!output.includes(f.state.refresh_token));assert.ok(!output.includes(f.state.wrapped_dek));
});
test('raw input preserves bytes and rejects size, symlink, FIFO, cancellation and silent stdin deadline',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'commerce-input-'));try{
  const file=join(dir,'body');await writeFile(file,Buffer.from([0,32,123,125,13,10]));assert.deepEqual(await readRaw(file),Buffer.from([0,32,123,125,13,10]));
  await symlink(file,join(dir,'link'));await assert.rejects(readRaw(join(dir,'link')),{code:'invalid_request'});
  await writeFile(file,Buffer.alloc(262145));await assert.rejects(readRaw(file),{code:'invalid_request'});await assert.rejects(readRaw('-',Readable.from([Buffer.alloc(262145)])),{code:'invalid_request'});
  if(process.platform!=='win32'){const fifo=join(dir,'pipe');await promisify(execFile)('mkfifo',[fifo]);await assert.rejects(readRaw(fifo),{code:'invalid_request'});}
  const abort=new AbortController();abort.abort();await assert.rejects(readRaw('-',new PassThrough(),abort.signal),{code:'cancelled'});
  await assert.rejects(readRaw('-',new PassThrough(),undefined,{timeoutMs:20}),{code:'invalid_request'});
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('command errors expose only safe code and MCP server errors are not echoed',async()=>{
 const values=[];const f=syntheticProtocol();await main(['login'],{...f,write:()=>{}});
 const transport=async(url,options)=>url==='https://api.sber-ai-pay.ru/mcp'?{status:400,data:{error:{message:'synthetic-private-token',access_token:f.state.access_token}}}:f.transport(url,options);
 assert.equal(await main(['mcp'],{...f,transport,input:Readable.from(['{}']),write:v=>values.push(JSON.parse(v))}),1);
 const r=values.at(-1);assert.deepEqual(r,{version:1,ok:false,error:{code:'remote_error',diagnostics:{phase:'mcp',http_status:400,time_utc:r.error.diagnostics.time_utc}}});
});
test('successful MCP cannot reflect session secrets through arbitrary text or nested private fields',async()=>{
 const values=[],f=syntheticProtocol();await main(['login'],{...f,write:()=>{}});
 const secrets=[f.state.refresh_token,f.state.access_token,f.state.wrapped_dek,f.state.wrapping_context];
 const transport=async(url,options)=>url==='https://api.sber-ai-pay.ru/mcp'?{status:200,data:{result:{content:[{text:secrets.join(' ')}],private_jwk:f.keys.sign.export({format:'jwk'})}}}:f.transport(url,options);
 assert.equal(await main(['mcp'],{...f,transport,input:Readable.from(['{}']),write:v=>values.push(JSON.parse(v))}),0);
 const output=JSON.stringify(values);for(const secret of secrets)assert.ok(!output.includes(secret));assert.ok(!output.includes(f.keys.sign.export({format:'jwk'}).d));
});
test('raw input refuses links even when the platform open flag does not prevent following',async t=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'commerce-no-follow-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const body=join(directory,'body'),link=join(directory,'link');await writeFile(body,'{}');await symlink(body,link);
 const original=fs.open;t.mock.method(fs,'open',(path,flags,...args)=>original(path,typeof flags==='number'?flags&~(constants.O_NOFOLLOW??0):flags,...args));syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 await assert.rejects(readRaw(link),{code:'invalid_request'});
});
test('raw input rejects an identity replacement between metadata inspection and open',async t=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'commerce-input-race-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const body=join(directory,'body');await writeFile(body,'original');const original=fs.open;let replaced=false;
 t.mock.method(fs,'open',async(path,...args)=>{if(path===body&&!replaced){replaced=true;await rename(body,join(directory,'old'));await writeFile(body,'replacement');}return original(path,...args);});syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 await assert.rejects(readRaw(body),{code:'invalid_request'});
});
test('raw input refuses directory-link ancestors including Windows junctions',async t=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'commerce-input-parent-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const target=join(directory,'target');await mkdir(target);await writeFile(join(target,'body'),'{}');const link=join(directory,'link');await symlink(target,link,process.platform==='win32'?'junction':'dir');
 await assert.rejects(readRaw(join(link,'body')),{code:'invalid_request'});
});
test('Windows input metadata helper is read-only and policy refusal stays a safe failure',async t=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'commerce-input-native-'));t.after(()=>rm(directory,{recursive:true,force:true}));const body=join(directory,'body');await writeFile(body,'{}');
 const descriptor=Object.getOwnPropertyDescriptor(process,'platform'),previous=process.env.SystemRoot;Object.defineProperty(process,'platform',{...descriptor,value:'win32'});process.env.SystemRoot='C:\\Windows';
 const operations=[];let deny=false;t.mock.method(childProcess,'spawn',(_program,args)=>{assert.ok(!args.some(arg=>/executionpolicy|bypass/i.test(arg)));const child=new EventEmitter();for(const name of ['stdin','stdout','stderr'])child[name]=new PassThrough();child.kill=()=>{};let bytes='';child.stdin.on('data',chunk=>bytes+=chunk);child.stdin.on('end',()=>{operations.push(JSON.parse(bytes));child.stdout.end(deny?'':'{"ok":true}');child.emit('close',deny?1:0);});return child;});syncBuiltinESMExports();
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();Object.defineProperty(process,'platform',descriptor);if(previous===undefined)delete process.env.SystemRoot;else process.env.SystemRoot=previous;});
 assert.equal((await readRaw(body)).toString(),'{}');assert.equal(operations.length,3);assert.ok(operations.every(value=>value.operation==='input'&&value.path===body));
 deny=true;await assert.rejects(readRaw(body),{code:'secret_provider_unavailable'});
});
