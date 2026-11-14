import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,access,realpath} from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {install} from '../scripts/lib/install.mjs';
import {Storage} from '../cli/storage.mjs';
import {documentedInvocation} from './fixtures/invocation.mjs';

const source=fileURLToPath(new URL('..',import.meta.url));

test('actual installed skill and encrypted CLI work together without login or network',async t=>{
  const base=await mkdtemp(join(await realpath(tmpdir()),'ai-commerce-acceptance-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const home=join(base,'clean home with spaces');
  await mkdir(home);
  const out=await install({source,home,agent:'both'});
  for(const skill of out.skills){
    const text=await readFile(join(skill,'SKILL.md'),'utf8');
    assert.deepEqual(documentedInvocation(text),[out.node,out.launcher],'registered skill must resolve the actual executable/launcher pair');
  }
  function run(args,fd){
    const r=spawnSync(out.node,[out.launcher,...args],{
      encoding:'utf8',timeout:20000,stdio:['pipe','pipe','pipe',...(fd===undefined?[]:[fd])],
    });
    assert.equal(r.status,0,r.stderr||r.stdout);
    const envelope=JSON.parse(r.stdout);
    assert.equal(envelope.ok,true,r.stdout);
    assert.equal(envelope.version,1);
    return {r,data:envelope.data};
  }
  assert.equal(run(['--version']).data.version,'0.4.0');
  run(['--help']);
  const directory=join(base,'fresh encrypted device');
  assert.equal(run(['status','--state-dir',directory]).data.status,'signed_out');
  await assert.rejects(access(directory),{code:'ENOENT'});

  // A synthetic local vault tests inherited-FD propagation end-to-end. These
  // random test bytes are never a user's password, key or production token.
  const passwordPath=join(base,'test passphrase');
  const password=randomBytes(32).toString('hex');
  await writeFile(passwordPath,password+'\n',{mode:0o600,flag:'wx'});
  let fd=openSync(passwordPath,'r');
  try{
    const store=new Storage(directory,'mcp',{passphraseFd:fd});
    await store.withLock(async s=>{assert.ok(await s.keys(true));});
  }finally{closeSync(fd);}
  const ciphertext=await readFile(join(directory,'vault.json'),'utf8');
  assert.ok(!ciphertext.includes(password));
  assert.ok(!ciphertext.includes('private_jwk'));
  fd=openSync(passwordPath,'r');
  try{
    const {r,data}=run(['status','--state-dir',directory,'--passphrase-fd','3'],fd);
    assert.equal(data.status,'signed_out');
    assert.ok(!r.stdout.includes(password));
    assert.ok(!r.stderr.includes(password));
  }finally{closeSync(fd);}
});
