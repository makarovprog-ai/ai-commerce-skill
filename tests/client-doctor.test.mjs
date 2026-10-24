import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CommerceClient} from '../cli/workflow.mjs';
import {inspectSecretProvider} from '../cli/secret-store.mjs';

async function fixture(t){const root=await fs.realpath(tmpdir());const directory=await fs.mkdtemp(join(root,'ai-commerce-doctor-'));await fs.chmod(directory,0o700);t.after(()=>fs.rm(directory,{recursive:true,force:true}));return directory;}
function noNativeOrSecrets(t){t.mock.method(childProcess,'spawn',()=>{throw Error('doctor must never spawn or unlock');});syncBuiltinESMExports();t.mock.method(fs,'readFile',()=>{throw Error('doctor must not read secret files');});t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});}
function executable(){return {isFile:()=>true,isSymbolicLink:()=>false,mode:0o100755,uid:0,nlink:1};}

test('doctor reports missing Linux prerequisites without subprocesses, secrets, mutations or network',async t=>{
 const directory=await fixture(t);noNativeOrSecrets(t);const original=fs.lstat;
 t.mock.method(fs,'lstat',async path=>{if(path==='/usr/bin/secret-tool')throw Object.assign(Error('missing'),{code:'ENOENT'});return original(path);});
 const result=await inspectSecretProvider({platform:'linux',directory});
 assert.equal(result.backend,'linux_secret_service');assert.equal(result.status,'unavailable');assert.equal(result.unlock,'not_checked');assert.deepEqual(result.prerequisites,[{name:'secret_tool',status:'unavailable'}]);assert.match(result.next_action,/Secret Service/);
 assert.deepEqual(await fs.readdir(directory),[]);
});
test('present native prerequisite is unlock_unverified, never verified storage',async t=>{
 const directory=await fixture(t);noNativeOrSecrets(t);const original=fs.lstat,access=fs.access;
 t.mock.method(fs,'lstat',async path=>path==='/usr/bin/secret-tool'?executable():original(path));t.mock.method(fs,'access',async(path,mode)=>path==='/usr/bin/secret-tool'?undefined:access(path,mode));
 const result=await inspectSecretProvider({platform:'linux',directory});assert.equal(result.status,'unlock_unverified');assert.equal(result.unlock,'not_checked');assert.equal(result.prerequisites[0].status,'present');
 assert.equal(result.directory.status,'present');assert.equal(result.directory.permissions,process.platform==='win32'?'not_checked':'verified');
});
test('macOS and Windows diagnostics only inspect fixed native prerequisites and leave policy unchecked',async t=>{
 const directory=await fixture(t);noNativeOrSecrets(t);const original=fs.lstat,access=fs.access,previous=process.env.SystemRoot;process.env.SystemRoot='C:\\Windows';
 t.after(()=>{if(previous===undefined)delete process.env.SystemRoot;else process.env.SystemRoot=previous;});
 const inspected=[];t.mock.method(fs,'lstat',async path=>{if(path==='/usr/bin/security'||String(path).endsWith('powershell.exe')||String(path).endsWith('windows-storage.ps1')){inspected.push(String(path));return executable();}return original(path);});
 t.mock.method(fs,'access',async(path,mode)=>path==='/usr/bin/security'||String(path).endsWith('powershell.exe')?undefined:access(path,mode));
 const mac=await inspectSecretProvider({platform:'darwin',directory});assert.equal(mac.backend,'macos_keychain');assert.equal(mac.status,'unlock_unverified');
 const windows=await inspectSecretProvider({platform:'win32',directory});assert.equal(windows.backend,'windows_dpapi');assert.equal(windows.status,'unlock_unverified');assert.equal(windows.policy,'not_checked');assert.match(windows.next_action,/policy/);assert.ok(inspected.includes('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'));
});
test('doctor checks inherited FD metadata without consuming the passphrase or creating state',async t=>{
 const directory=await fixture(t),password=join(directory,'synthetic-input');await fs.writeFile(password,'synthetic-test-passphrase');const handle=await fs.open(password,'r');t.after(()=>handle.close());
 noNativeOrSecrets(t);const result=await new CommerceClient({directory:join(directory,'missing'),storageOptions:{passphraseFd:handle.fd},transport:()=>{throw Error('no network');}}).doctor();
 assert.equal(result.storage.backend,'passphrase_fd');assert.equal(result.storage.status,'unlock_unverified');assert.equal(result.storage.directory.status,'not_created');
 const bytes=Buffer.alloc(25);assert.equal((await handle.read(bytes,0,25,null)).bytesRead,25);assert.equal(bytes.toString(),'synthetic-test-passphrase');assert.deepEqual(await fs.readdir(directory),['synthetic-input']);
});
test('doctor refuses unsafe metadata and does not treat custom providers as verified',async t=>{
 const directory=await fixture(t),link=join(directory,'linked');await fs.symlink(directory,link,process.platform==='win32'?'junction':'dir');noNativeOrSecrets(t);
 const result=await inspectSecretProvider({platform:'linux',directory:link,secretProvider:{get(){throw Error('no secret access');}}});assert.equal(result.directory.status,'unavailable');assert.equal(result.status,'unavailable');
 const custom=await inspectSecretProvider({directory,secretProvider:{get(){throw Error('no secret access');}}});assert.equal(custom.backend,'custom');assert.equal(custom.status,'not_checked');
});
test('doctor supports exactly Node24, not newer or older majors',async t=>{
 const directory=await fixture(t),descriptor=Object.getOwnPropertyDescriptor(process.versions,'node');t.after(()=>Object.defineProperty(process.versions,'node',descriptor));
 const client=new CommerceClient({directory,storageOptions:{secretProvider:{get(){throw Error('no secret access');}}}});
 for(const [node,want] of [['23.9.0',false],['24.21.0',true],['25.0.0',false]]){Object.defineProperty(process.versions,'node',{...descriptor,value:node});assert.equal((await client.doctor()).runtime.supported,want);}
});
