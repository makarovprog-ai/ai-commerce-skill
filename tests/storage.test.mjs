import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,writeFile,mkdir,chmod,symlink,link,rm,open,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scryptSync,createDecipheriv} from 'node:crypto';
const secret = Buffer.alloc(32, 7);
const provider = (key = secret) => ({get:async()=>Buffer.from(key)});
async function fixture(t) {
  const root=await mkdtemp(join(await realpath(tmpdir()),'ai-commerce-storage-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const {Storage}=await import('../cli/storage.mjs');
  return {root,Storage,store:new Storage(join(root,'state'),'mcp',{secretProvider:provider()})};
}
const state = keys => ({version:1,client_id:'vps-mcp-companion',sign_jkt:keys.signJkt,wrap_jkt:keys.wrapJkt,
  access_token:'eyJhIjoxfQ.eyJiIjoyfQ.c2lnbmF0dXJl',refresh_token:'r'.repeat(43),expires_at:1900000000,
  user_id:'10000000-0000-0000-0000-000000000001',device_id:'10000000-0000-0000-0000-000000000002',
  grant_id:'10000000-0000-0000-0000-000000000003',family_id:'10000000-0000-0000-0000-000000000004',
  packet_id:'10000000-0000-0000-0000-000000000005',wrapped_dek:Buffer.alloc(256,3).toString('base64url'),
  wrapping_context:Buffer.from('test wrapping context').toString('base64url'),dek_generation:1,rotation_in_flight:false});

test('missing read-only state does not create any files or call secret provider',async t=>{
  const {root,Storage}=await fixture(t);const directory=join(root,'absent');
  const store=new Storage(directory,'mcp',{secretProvider:{get(){throw Error('must not unlock');}}});
  assert.equal(await store.withLock(s=>s,{create:false}),null);
  assert.deepEqual(await readdir(root),[]);
});
test('keys and session round-trip without any private JWK or token persisted in clear',async t=>{
  const {store,Storage}=await fixture(t);let original;
  await store.withLock(async s=>{original=await s.keys(true);await s.save(original,state(original));});
  const reopened=new Storage(store.directory,'mcp',{secretProvider:provider()});
  await reopened.withLock(async s=>{const keys=await s.keys();assert.equal(keys.signJkt,original.signJkt);assert.deepEqual(await s.session(keys),state(keys));});
  const disk=Buffer.concat(await Promise.all((await readdir(store.directory)).map(n=>readFile(join(store.directory,n))))).toString();
  for(const privateValue of [original.sign.export({format:'jwk'}).d,original.wrap.export({format:'jwk'}).d,state(original).refresh_token,state(original).access_token,'private_jwk'])assert.equal(disk.includes(privateValue),false);
});
test('wrong provider key and modified ciphertext fail closed',async t=>{
  const {store,Storage}=await fixture(t);await store.withLock(s=>s.write('record',{value:'secret'}));
  const wrong=new Storage(store.directory,'mcp',{secretProvider:provider(Buffer.alloc(32,8))});
  await assert.rejects(()=>wrong.read('record'),{code:'unsafe_storage'});
  const file=join(store.directory,'vault.json'),data=JSON.parse(await readFile(file,'utf8'));
  data.tag=Buffer.alloc(16,0).toString('base64url');await writeFile(file,JSON.stringify(data),{mode:0o600});
  await assert.rejects(()=>store.read('record'),{code:'unsafe_storage'});
});
test('vault is bound to directory and profile, even with same injected key',async t=>{
  const {root,store,Storage}=await fixture(t);await store.withLock(s=>s.write('record',{value:1}));
  const other=join(root,'other');await mkdir(other,{mode:0o700});await writeFile(join(other,'vault.json'),await readFile(join(store.directory,'vault.json')),{mode:0o600});
  await assert.rejects(()=>new Storage(other,'mcp',{secretProvider:provider()}).read('record'),{code:'unsafe_storage'});
  await assert.rejects(()=>new Storage(store.directory,'diagnostic',{secretProvider:provider()}).read('record'),{code:'unsafe_storage'});
});
test('rotation-in-flight survives reopen and logout retains device keys but deletes session',async t=>{
  const {store,Storage}=await fixture(t);let jkt;
  await store.withLock(async s=>{const k=await s.keys(true);jkt=k.signJkt;await s.save(k,{...state(k),rotation_in_flight:true});});
  await new Storage(store.directory,'mcp',{secretProvider:provider()}).withLock(async s=>{const k=await s.keys();assert.equal((await s.session(k)).rotation_in_flight,true);await s.logout();assert.equal(await s.session(k),null);assert.equal((await s.keys()).signJkt,jkt);});
});
test('invalid session schema is rejected before replacing last valid state',async t=>{
  const {store}=await fixture(t);await store.withLock(async s=>{const k=await s.keys(true);await s.save(k,state(k));await assert.rejects(()=>s.save(k,{...state(k),client_id:'other'}),{code:'unsafe_storage'});assert.deepEqual(await s.session(k),state(k));});
});
test('concurrent writers are rejected and callback failure releases lock',async t=>{
  const {store,Storage}=await fixture(t);const other=new Storage(store.directory,'mcp',{secretProvider:provider()});
  await store.withLock(async()=>{await assert.rejects(()=>other.withLock(()=>{}),{code:'storage_locked'});});
  await assert.rejects(()=>store.withLock(()=>{throw Error('expected');}),/expected/);
  await other.withLock(s=>s.write('record',{ok:true}));
});
test('logical names cannot traverse or escape encrypted vault',async t=>{
  const {store}=await fixture(t);await store.withLock(async s=>{for(const name of ['../escape','/absolute','a/b','writer.lock','__proto__'])await assert.rejects(()=>s.write(name,{a:1}),{code:'unsafe_storage'});});
});
test('symlink directory and vault fail closed',async t=>{
  const {root,store,Storage}=await fixture(t);await store.withLock(s=>s.write('record',{a:1}));
  await symlink(store.directory,join(root,'alias'),'dir');
  await assert.rejects(()=>new Storage(join(root,'alias'),'mcp',{secretProvider:provider()}).read('record'),{code:'unsafe_storage'});
  const original=join(root,'original');await writeFile(original,await readFile(join(store.directory,'vault.json')),{mode:0o600});await rm(join(store.directory,'vault.json'));await symlink(original,join(store.directory,'vault.json'));
  await assert.rejects(()=>store.read('record'),{code:'unsafe_storage'});
});
test('hardlinked vault and unsafe permissions fail closed',async t=>{
  const {root,store}=await fixture(t);await store.withLock(s=>s.write('record',{a:1}));
  await link(join(store.directory,'vault.json'),join(root,'hardlink'));
  await assert.rejects(()=>store.read('record'),{code:'unsafe_storage'});await rm(join(root,'hardlink'));
  if(process.platform!=='win32'){await chmod(join(store.directory,'vault.json'),0o644);await assert.rejects(()=>store.read('record'),{code:'unsafe_storage'});}
});
test('uncommitted temporary vault does not overwrite committed state',async t=>{
  const {store}=await fixture(t);await store.withLock(s=>s.write('record',{value:'before'}));
  await writeFile(join(store.directory,'.vault.interrupted.tmp'),'incomplete ciphertext',{mode:0o600});
  assert.deepEqual(await store.read('record'),{value:'before'});
  await store.withLock(s=>s.write('record',{value:'after'}));assert.deepEqual(await store.read('record'),{value:'after'});
});
test('passphrase FD backend reopens only with correct passphrase and unique salts',async t=>{
  const {root,Storage}=await fixture(t);const pass=join(root,'password');await writeFile(pass,'a sufficiently long test passphrase\n',{mode:0o600});
  const fd=await open(pass,'r');t.after(()=>fd.close());
  const one=new Storage(join(root,'one'),'mcp',{passphraseFd:fd.fd});await one.withLock(s=>s.write('record',{secret:'value'}));
  const fd2=await open(pass,'r');t.after(()=>fd2.close());const reopened=new Storage(one.directory,'mcp',{passphraseFd:fd2.fd});assert.deepEqual(await reopened.read('record'),{secret:'value'});
  const fd3=await open(pass,'r');t.after(()=>fd3.close());const two=new Storage(join(root,'two'),'mcp',{passphraseFd:fd3.fd});await two.withLock(s=>s.write('record',{secret:'value'}));
  assert.notDeepEqual(await readFile(join(one.directory,'passphrase-salt.json')),await readFile(join(two.directory,'passphrase-salt.json')));
  await writeFile(pass,'wrong sufficiently long passphrase\n');const bad=await open(pass,'r');t.after(()=>bad.close());
  await assert.rejects(()=>new Storage(one.directory,'mcp',{passphraseFd:bad.fd}).read('record'),{code:'unsafe_storage'});
});
test('physical legacy key files are not migrated or ignored during new custody initialization',async t=>{
  const {store}=await fixture(t);await mkdir(store.directory,{mode:0o700});
  await writeFile(join(store.directory,'sign.json'),'{"private_jwk":"legacy-marker"}',{mode:0o600});
  await assert.rejects(()=>store.withLock(s=>s.keys(true)),{code:'unsafe_storage'});
  assert.equal(await readFile(join(store.directory,'sign.json'),'utf8'),'{"private_jwk":"legacy-marker"}');
});
test('absent native backend automatically persists a local key for a fresh vault',async t=>{
  const {root}=await fixture(t);const {createSecretProvider}=await import('../cli/storage.mjs');
  const p=createSecretProvider({directory:root,platform:'unsupported'});
  assert.equal((await p.get({id:'a'.repeat(64),create:true})).length,32);
  assert.deepEqual(await readdir(root),['key.local.json']);
});
test('failed serialization leaves old authenticated vault and no temporary files',async t=>{
  const {store}=await fixture(t);await store.withLock(async s=>{await s.write('record',{value:'before'});const cycle={};cycle.self=cycle;await assert.rejects(()=>s.write('record',cycle));});
  assert.deepEqual(await store.read('record'),{value:'before'});assert.deepEqual(await readdir(store.directory),['vault.json']);
});
test('unsafe directories, checkout directories and noncanonical paths are rejected',async t=>{
  const {root,Storage}=await fixture(t);
  assert.throws(()=>new Storage(join(root,'x')+'/../state'),{code:'unsafe_storage'});
  assert.throws(()=>new Storage('relative'),{code:'unsafe_storage'});
  const publicPath=join(root,'public');await assert.rejects(()=>new Storage(publicPath).withLock(()=>{}),{code:'unsafe_storage'});
  const checkout=join(root,'checkout');await mkdir(checkout,{mode:0o700});await mkdir(join(checkout,'.git'));await writeFile(join(checkout,'.git','HEAD'),'ref: refs/heads/main');
  await assert.rejects(()=>new Storage(join(checkout,'state')).withLock(()=>{}),{code:'unsafe_storage'});
  if(process.platform!=='win32'){const loose=join(root,'loose');await mkdir(loose,{mode:0o755});await assert.rejects(()=>new Storage(loose).withLock(()=>{}),{code:'unsafe_storage'});}
});
test('concurrent observers only see complete authenticated commits',async t=>{
  const {store,Storage}=await fixture(t);await store.withLock(s=>s.write('record',{generation:0,payload:'x'.repeat(2000)}));
  const observer=new Storage(store.directory,'mcp',{secretProvider:provider()});
  for(let i=1;i<=12;i++){
    const [,record]=await Promise.all([store.withLock(s=>s.write('record',{generation:i,payload:'x'.repeat(2000)})),observer.read('record')]);
    assert.ok(record.generation===i||record.generation===i-1);assert.equal(record.payload.length,2000);
  }
});
test('passphrase vault uses the documented memory-hard scrypt profile',async t=>{
  const {root,Storage}=await fixture(t);const path=join(root,'password');await writeFile(path,'memory hard test passphrase\n',{mode:0o600});const fd=await open(path,'r');t.after(()=>fd.close());
  const store=new Storage(join(root,'state'),'mcp',{passphraseFd:fd.fd});await store.withLock(s=>s.write('record',{value:'protected'}));
  const salt=JSON.parse(await readFile(join(store.directory,'passphrase-salt.json'))),vault=JSON.parse(await readFile(join(store.directory,'vault.json')));
  const key=scryptSync('memory hard test passphrase',Buffer.from(salt.salt,'hex'),32,{N:131072,r:8,p:1,maxmem:256*1024*1024});
  try{const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(vault.iv,'base64url'));cipher.setAAD(Buffer.from('ai-commerce-vault-v1:'+vault.id));cipher.setAuthTag(Buffer.from(vault.tag,'base64url'));const data=JSON.parse(Buffer.concat([cipher.update(Buffer.from(vault.ciphertext,'base64url')),cipher.final()]));assert.equal(data.records.record.value,'protected');}finally{key.fill(0);}
});
