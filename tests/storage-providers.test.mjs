import test from 'node:test';
import assert from 'node:assert/strict';
import {createSecretProvider} from '../cli/secret-store.mjs';
import {nativeRun,windowsNative} from '../cli/platform-storage.mjs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {publicError} from '../cli/errors.mjs';

test('Windows helper honors host execution policy and uses only an absolute system executable',async t=>{
 const calls=[];const previous=process.env.SystemRoot;process.env.SystemRoot='C:\\Windows';
 t.mock.method(childProcess,'spawn',(program,args,options)=>{
  calls.push({program,args,options});const child=new EventEmitter();for(const name of ['stdin','stdout','stderr'])child[name]=new PassThrough();child.kill=()=>{};
  child.stdin.resume();queueMicrotask(()=>{child.stdout.end('{"ok":true}');child.emit('close',0);});return child;
 });syncBuiltinESMExports();
 try{assert.deepEqual(await windowsNative({operation:'check',path:'C:\\private'}),{ok:true});
  assert.ok(!calls[0].args.some(arg=>/executionpolicy|bypass/i.test(arg)));assert.equal(calls[0].options.shell,false);
  assert.equal(calls[0].program,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
 }finally{t.mock.restoreAll();syncBuiltinESMExports();if(previous===undefined)delete process.env.SystemRoot;else process.env.SystemRoot=previous;}
});
test('native launch refuses PATH resolution and failures offer policy-preserving guidance',async t=>{
 t.mock.method(childProcess,'spawn',()=>{throw Error('PATH launch must not be attempted');});syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 await assert.rejects(nativeRun('powershell.exe',[]),{code:'secret_provider_unavailable'});
 const output=publicError(new (await import('../cli/errors.mjs')).ClientError('secret_provider_unavailable'));
 assert.match(output.next_action,/doctor/);assert.match(output.next_action,/policy/);assert.ok(!JSON.stringify(output).includes('Bypass'));
});

test('macOS native provider sends generated password only via stdin and verifies persistence',async()=>{
  const calls=[];let stored;
  const run=async(program,args,input='')=>{calls.push({program,args,input});
    if(args.includes('-i')){stored=input.match(/-w ([0-9a-f]{64})\n$/)?.[1];return {code:0,stdout:Buffer.alloc(0)};}
    return {code:stored?0:44,stdout:Buffer.from(stored?stored+'\n':'')};};
  const p=createSecretProvider({platform:'darwin',run});const key=await p.get({id:'a'.repeat(64),create:true});
  assert.equal(key.length,32);assert.equal(calls.length,3);
  assert.deepEqual(calls[1].args,['-i']);assert.equal(calls.every(c=>!c.args.includes(key.toString('hex'))),true);
  assert.deepEqual(await p.get({id:'a'.repeat(64)}),key);
});
test('macOS interactive exit success without saved item does not accept a key',async()=>{
  const run=async(_program,args)=>({code:args.includes('-i')?0:44,stdout:Buffer.alloc(0)});
  await assert.rejects(()=>createSecretProvider({platform:'darwin',run}).get({id:'b'.repeat(64),create:true}),{code:'secret_provider_unavailable'});
});
test('native subprocess errors cannot disclose secret stdin or diagnostic output',async()=>{
  await assert.rejects(()=>nativeRun(process.execPath,['-e',"process.stdin.on('data',b=>{process.stdout.write(b);process.stderr.write(b);process.exit(2)})"],'secret-not-for-output'),error=>error.code==='secret_provider_unavailable'&&!String(error).includes('secret-not-for-output'));
});
test('hung native subprocess has a bounded deadline',async()=>{
  const started=Date.now();await assert.rejects(()=>nativeRun(process.execPath,['-e','setInterval(()=>{},1000)'],'',{timeout:50}),{code:'secret_provider_unavailable'});assert.ok(Date.now()-started<2000);
});
test('Linux keyring persists and retrieves a generated key without secret argv',async()=>{
  let stored;const calls=[];
  const run=async(program,args,input='')=>{calls.push({program,args,input});if(args[0]==='store'){stored=input.trim();return {code:0,stdout:Buffer.alloc(0)};}return {code:stored?0:1,stdout:Buffer.from(stored?stored+'\n':'')};};
  const key=await createSecretProvider({platform:'linux',run}).get({id:'c'.repeat(64),create:true});
  assert.equal(key.length,32);assert.equal(calls.length,3);assert.equal(calls.every(c=>!c.args.some(arg=>arg.includes(key.toString('hex')))),true);
  assert.deepEqual(await createSecretProvider({platform:'linux',run}).get({id:'c'.repeat(64)}),key);
});
test('a cached provider cannot return another vault namespace key',async()=>{
  let key='d'.repeat(64);const run=async()=>({code:0,stdout:Buffer.from(key)});
  const provider=createSecretProvider({platform:'linux',run});await provider.get({id:'d'.repeat(64)});
  await assert.rejects(()=>provider.get({id:'e'.repeat(64)}),{code:'secret_provider_unavailable'});
});
