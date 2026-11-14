import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,realpath,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('update checks cache failures for a day, do not block business and announce an available version once',async t=>{
 const mod=await import('../cli/updates.mjs').catch(()=>({}));assert.equal(typeof mod.checkUpdate,'function','local update checker is missing');
 const base=await mkdtemp(join(await realpath(tmpdir()),'commerce-updates-'));t.after(()=>rm(base,{recursive:true,force:true}));
 let now=1700000000000,calls=0,fail=true;
 const load=async()=>({origin:'git@example.test:org/repo.git',version:'0.4.0'});
 const latest=async()=>{calls++;if(fail)throw Error('private credential failure');return {version:'0.5.0',commit:'b'.repeat(40)};};
 const options={root:base,load,latest,now:()=>now};
 assert.deepEqual(await mod.checkUpdate(options),{status:'unavailable'});assert.equal(calls,1);
 now+=60000;assert.deepEqual(await mod.checkUpdate(options),{status:'unavailable'});assert.equal(calls,1);
 now+=86400000;fail=false;const found=await mod.checkUpdate(options);assert.equal(found.status,'available');assert.equal(found.notice.code,'update_available');
 assert.equal((await mod.checkUpdate(options)).notice,undefined);assert.equal(calls,2);
 const bytes=await readFile(join(base,'update-check.json'),'utf8');assert.ok(!bytes.includes('credential'));
});
test('parallel checks do one remote operation and explicit check retains machine unavailable status',async t=>{
 const mod=await import('../cli/updates.mjs').catch(()=>({}));assert.equal(typeof mod.checkUpdate,'function');
 const root=await mkdtemp(join(await realpath(tmpdir()),'commerce-update-parallel-'));t.after(()=>rm(root,{recursive:true,force:true}));let calls=0;
 const options={root,load:async()=>({origin:'git@example.test:org/repo.git',version:'0.4.0'}),latest:async()=>{calls++;await new Promise(r=>setTimeout(r,25));return {version:'0.4.0',commit:'a'.repeat(40)};}};
 const results=await Promise.all([mod.checkUpdate(options),mod.checkUpdate(options)]);assert.equal(calls,1);assert.ok(results.some(r=>r.status==='up_to_date'));
});
test('release discovery rejects unsafe sources and selects stable semver tags rather than tag date',async()=>{
 const mod=await import('../scripts/lib/release.mjs').catch(()=>({}));assert.equal(typeof mod.latestRelease,'function');
 for(const source of ['file:///tmp/repo','https://user:secret@example.test/repo','-oProxyCommand=bad','ext::evil','http://example.test/repo','git@example.test:org/repo.git\ncommand'])assert.throws(()=>mod.validateOrigin(source));
 assert.equal(mod.validateOrigin('git@example.test:org/repo.git'),'git@example.test:org/repo.git');
 const calls=[];const run=async(args,options)=>{calls.push({args,options});return `${'a'.repeat(40)}\trefs/tags/v0.9.0\n${'b'.repeat(40)}\trefs/tags/v0.10.0\n${'c'.repeat(40)}\trefs/tags/v1.0.0-rc1\n${'d'.repeat(40)}\trefs/tags/v0.10.0^{}\n`;};
 assert.deepEqual(await mod.latestRelease('git@example.test:org/repo.git',{run}),{version:'0.10.0',commit:'d'.repeat(40),tag:'v0.10.0'});
 assert.ok(calls[0].args.includes('ls-remote'));assert.ok(calls[0].options.timeout<=3000);
});
test('bad or linked update cache is silent and never overwritten or followed',async t=>{
 const {checkUpdate}=await import('../cli/updates.mjs');
 const root=await mkdtemp(join(await realpath(tmpdir()),'commerce-bad-cache-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'update-check.json'),outside=join(root,'unrelated');await writeFile(file,'not JSON');await writeFile(outside,'keep');
 const options={root,load:async()=>({origin:'git@example.test:org/repo.git',version:'0.4.0'}),latest:async()=>{throw Error('must not query');}};
 assert.deepEqual(await checkUpdate(options),{status:'unavailable'});assert.equal(await readFile(file,'utf8'),'not JSON');
 await rm(file);await symlink(outside,file);assert.deepEqual(await checkUpdate(options),{status:'unavailable'});assert.equal(await readFile(outside,'utf8'),'keep');
});
