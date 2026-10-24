import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,readdir,stat,symlink,link,chmod,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Storage} from '../cli/storage.mjs';
import {createSecretProvider,inspectSecretProvider} from '../cli/secret-store.mjs';
import {ClientError} from '../cli/errors.mjs';
import {protect} from '../cli/platform-storage.mjs';
const missing=async()=>{throw new ClientError('secret_provider_unavailable');};
async function fixture(t){const directory=await mkdtemp(join(await realpath(tmpdir()),'commerce-local-'));await chmod(directory,0o700);await protect(directory);t.after(()=>rm(directory,{recursive:true,force:true}));return directory;}
function store(directory,notices=[]){return new Storage(directory,'mcp',{secretProvider:createSecretProvider({directory,platform:'linux',run:missing,onNotice:n=>notices.push(n)})});}

test('missing native store automatically creates a persistent guarded key and reopens encrypted custody',async t=>{
  const directory=await fixture(t),notices=[];let thumb;
  await store(directory,notices).withLock(async s=>{const keys=await s.keys(true);thumb=keys.signJkt;await s.write('example',{value:'synthetic-secret-payload'});});
  const files=await readdir(directory);assert.ok(files.includes('key.local.json'));
  const key=JSON.parse(await readFile(join(directory,'key.local.json'),'utf8'));
  assert.equal(key.version,1);assert.match(key.key,/^[a-f0-9]{64}$/);
  const vault=await readFile(join(directory,'vault.json'),'utf8');assert.ok(!vault.includes(key.key));assert.ok(!vault.includes('synthetic-secret-payload'));assert.ok(!vault.includes('private_jwk'));
  if(process.platform!=='win32'){assert.equal((await stat(directory)).mode&511,0o700);assert.equal((await stat(join(directory,'key.local.json'))).mode&511,0o600);}
  assert.equal(notices.length,1);assert.equal(notices[0].code,'local_key_storage');assert.ok(!JSON.stringify(notices).includes(key.key));
  await store(directory).withLock(async s=>{assert.equal((await s.keys(false)).signJkt,thumb);assert.equal((await s.read('example')).value,'synthetic-secret-payload');});
  const run=spawnSync(process.execPath,[fileURLToPath(new URL('../bin/ai-commerce.mjs',import.meta.url)),'status','--state-dir',directory],{encoding:'utf8',timeout:30000});
  assert.equal(run.status,0,run.stderr||run.stdout);const output=JSON.parse(run.stdout);assert.equal(output.data.status,'signed_out');assert.equal(output.notices[0].code,'local_key_storage');assert.ok(!run.stdout.includes(key.key));
});
test('an existing file key stays selected without invoking a newly available native store',async t=>{
  const directory=await fixture(t);await store(directory).withLock(s=>s.keys(true));
  const data=JSON.parse(await readFile(join(directory,'key.local.json'),'utf8'));
  const p=createSecretProvider({directory,run:async()=>{throw Error('native provider must not be called');}});
  assert.ok((await p.get({id:data.id})).equals(Buffer.from(data.key,'hex')));
});
test('working native provider remains preferred and no local key is created',async t=>{
  const directory=await fixture(t),notices=[];
  const p=createSecretProvider({directory,onNotice:n=>notices.push(n),platform:'linux',run:async()=>({code:0,stdout:Buffer.from('a'.repeat(64))})});
  assert.equal((await p.get({id:'b'.repeat(64),create:true})).length,32);assert.deepEqual(await readdir(directory),[]);assert.deepEqual(notices,[]);
});
test('native failure never rekeys an existing vault or overwrites its bytes',async t=>{
  const directory=await fixture(t);await writeFile(join(directory,'vault.json'),'original-native-vault',{mode:0o600});await protect(join(directory,'vault.json'));
  const p=createSecretProvider({directory,platform:'linux',run:missing});await assert.rejects(p.get({id:'b'.repeat(64),create:true}),{code:'secret_provider_unavailable'});
  assert.equal(await readFile(join(directory,'vault.json'),'utf8'),'original-native-vault');assert.deepEqual(await readdir(directory),['vault.json']);
});
test('malformed native key is corruption, not permission to silently choose a file key',async t=>{
  const directory=await fixture(t),p=createSecretProvider({directory,platform:'linux',run:async()=>({code:0,stdout:Buffer.from('not-a-key')})});
  await assert.rejects(p.get({id:'b'.repeat(64),create:true}),{code:'unsafe_storage'});assert.deepEqual(await readdir(directory),[]);
});
test('successful empty native lookup is corruption and never triggers a store or fallback',async t=>{
  const directory=await fixture(t);let calls=0;
  const p=createSecretProvider({directory,platform:'linux',run:async()=>{calls++;if(calls===1)return {code:0,stdout:Buffer.alloc(0)};throw new ClientError('secret_provider_unavailable');}});
  await assert.rejects(p.get({id:'b'.repeat(64),create:true}),{code:'unsafe_storage'});assert.equal(calls,1);assert.deepEqual(await readdir(directory),[]);
});
test('native key readback mismatch never switches Linux or macOS custody to a file key',async t=>{
  for(const platform of ['linux','darwin']){
    const directory=await fixture(t);let calls=0;
    const p=createSecretProvider({directory,platform,run:async()=>{calls++;return calls===1?{code:platform==='linux'?1:44,stdout:Buffer.alloc(0)}:calls===2?{code:0,stdout:Buffer.alloc(0)}:{code:0,stdout:Buffer.from('c'.repeat(64))};}});
    await assert.rejects(p.get({id:'b'.repeat(64),create:true}),{code:'unsafe_storage'});assert.equal(calls,3);assert.deepEqual(await readdir(directory),[]);
  }
});
test('malformed or wrong-namespace local key fails closed without replacement',async t=>{
  const directory=await fixture(t);await store(directory).withLock(s=>s.keys(true));
  const file=join(directory,'key.local.json'),before=await readFile(file);const data=JSON.parse(before);
  await assert.rejects(createSecretProvider({directory,run:missing}).get({id:'0'.repeat(64)}),{code:'unsafe_storage'});assert.ok((await readFile(file)).equals(before));
  await writeFile(file,JSON.stringify({...data,extra:true}));await assert.rejects(store(directory).withLock(s=>s.keys(false)),{code:'unsafe_storage'});
});
test('local key links and loose permissions are rejected, never repaired silently',async t=>{
  const directory=await fixture(t),target=join(directory,'outside');await writeFile(target,'{}',{mode:0o600});await symlink(target,join(directory,'key.local.json'));
  await assert.rejects(store(directory).withLock(s=>s.keys(true)),{code:'unsafe_storage'});await rm(join(directory,'key.local.json'));
  await link(target,join(directory,'key.local.json'));await assert.rejects(store(directory).withLock(s=>s.keys(true)),{code:'unsafe_storage'});await rm(join(directory,'key.local.json'));
  if(process.platform!=='win32'){await writeFile(join(directory,'key.local.json'),'{}',{mode:0o644});await assert.rejects(store(directory).withLock(s=>s.keys(true)),{code:'unsafe_storage'});}
});
test('doctor explains automatic local fallback without creating or reading credential files',async t=>{
  const directory=await fixture(t);const r=await inspectSecretProvider({directory,platform:'unsupported'});
  assert.equal(r.fallback.backend,'local_file');assert.equal(r.fallback.automatic,true);assert.equal(r.fallback.persistent,true);assert.deepEqual(await readdir(directory),[]);
});
