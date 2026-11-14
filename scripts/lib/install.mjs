import { lstat, readFile, readdir, mkdir, mkdtemp, writeFile, rename, rm, rmdir, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {sourceIdentity,validateOrigin} from './release.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

export const SOURCE = 'ai-commerce-skill';
export class UpdateRecoveryError extends Error {
  constructor(){super('Update interrupted; recovery required. Backups retained.');this.code='update_recovery_required';}
}
const legacyPayload = ['package.json', 'bin/ai-commerce.mjs', ...['storage', 'secret-store', 'local-key', 'platform-storage', 'crypto', 'http', 'workflow', 'errors', 'app'].map(n => `cli/${n}.mjs`), 'cli/native/windows-storage.ps1', 'cli/native/read-passphrase.mjs'];
const payloadFiles = [...legacyPayload,'cli/tool-discovery.mjs','cli/updates.mjs','scripts/lib/install.mjs','scripts/lib/update.mjs','scripts/lib/release.mjs'];
const skillFiles = ['SKILL.md', 'references/setup.md', 'references/commands.md','references/search.md','references/checkout.md'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function exists(target) {
  try { return await lstat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Check each component, not only the leaf: recursive mkdir/copy would follow links.
export async function safePath(target, { create = false } = {}) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let info = await exists(cursor);
    if (!info && create) { await mkdir(cursor, { mode: 0o700 }); info = await lstat(cursor); }
    if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error(`Unsafe directory or symlink: ${cursor}`);
  }
  return absolute;
}

export async function regularFile(target) {
  await safePath(path.dirname(target));
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`Expected a regular, unlinked file: ${target}`);
  return readFile(target);
}

export async function inspectTree(directory) {
  const files = new Map();
  async function walk(current, prefix = '') {
    await safePath(current);
    for (const name of await readdir(current)) {
      const target = path.join(current, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error(`Unexpected symlink: ${target}`);
      if (info.isDirectory()) await walk(target, relative);
      else if (info.isFile() && info.nlink === 1) files.set(relative, await readFile(target));
      else throw new Error(`Unexpected entry: ${target}`);
    }
  }
  await walk(directory);
  return files;
}

function sameFiles(actual, expected) {
  return actual.size === expected.size && [...expected].every(([name, bytes]) => actual.get(name)?.equals(bytes));
}

async function checkDestination(directory, expected) {
  if (!(await exists(directory))) return false;
  const actual = await inspectTree(directory);
  if (!sameFiles(actual, expected)) throw new Error(`Installation collision or modified files: ${directory}`);
  return true;
}

export async function publish(directory, files) {
  await safePath(path.dirname(directory), { create: true });
  const stage = await mkdtemp(path.join(path.dirname(directory), '.ai-commerce-install-'));
  try {
    for (const [name, bytes] of files) {
      const target = path.join(stage, ...name.split('/'));
      await safePath(path.dirname(target), { create: true });
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    for (const name of ['node', 'node.exe']) if (files.has(name)) await chmod(path.join(stage, name), 0o700);
    // Never replace a preexisting destination, including an empty unowned folder.
    if (await exists(directory)) throw new Error(`Installation collision: ${directory}`);
    await rename(stage, directory);
  } finally { await rm(stage, { recursive: true, force: true }); }
}

export async function install({ source, home, project, scope = 'user', agent = 'codex',upgrade=false,origin,commit }) {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('AI Commerce requires Node.js 24 LTS. Use the local bootstrap.');
  if (!['codex', 'claude', 'both'].includes(agent)) throw new Error('Invalid agent; choose codex, claude or both.');
  if (!['user', 'project'].includes(scope)) throw new Error('Invalid scope; choose user or project.');
  if (scope === 'project' && !project) throw new Error('Project scope requires --project PATH.');
  source = await safePath(source);
  home = await safePath(home);
  const registerRoot = scope === 'project' ? await safePath(project) : home;
  const agents = agent === 'both' ? ['codex', 'claude'] : [agent];
  const targets = agents.map(a => path.join(registerRoot, a === 'codex' ? '.agents' : '.claude', 'skills/ai-commerce'));
  if(origin!==undefined)validateOrigin(origin);
  else ({origin,commit}=await sourceIdentity(source));
  if(commit!==undefined&&!/^[a-f0-9]{40,64}$/.test(commit))throw Error('Invalid source commit');
  const installation={home,...(scope==='project'?{project:registerRoot}:{}),scope,agent,...(origin?{origin,commit}:{}),targets};
  let payload=payloadFiles,skill=skillFiles;
  try{
    const raw=await regularFile(path.join(source,'distribution.json'));if(raw.length>32768)throw Error('Invalid distribution manifest');
    const manifest=JSON.parse(raw);
    const valid=(entries,pattern)=>Array.isArray(entries)&&entries.length>0&&entries.length<=100&&new Set(entries).size===entries.length&&entries.every(n=>typeof n==='string'&&pattern.test(n)&&!n.split('/').some(p=>p.startsWith('.')));
    if(manifest.version!==1||!valid(manifest.payload,/^(?:package\.json|bin\/ai-commerce\.mjs|(?:cli|scripts\/lib)\/[A-Za-z0-9_./-]+\.(?:mjs|ps1))$/)||!valid(manifest.skill,/^(?:SKILL\.md|references\/[A-Za-z0-9_/-]+\.md)$/)||!['package.json','bin/ai-commerce.mjs'].every(n=>manifest.payload.includes(n))||!manifest.skill.includes('SKILL.md'))throw Error('Invalid distribution manifest');
    payload=manifest.payload;skill=manifest.skill;
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const sourceFiles = new Map();
  for (const name of payload) sourceFiles.set(name, await regularFile(path.join(source, name)));
  const pkg = JSON.parse(sourceFiles.get('package.json'));
  if (pkg.name !== 'ai-commerce-skill' || !/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Invalid package identity or version.');
  // Copy a minimal ESM manifest, not package scripts, dependencies or private fields.
  sourceFiles.set('package.json', Buffer.from(`${JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module' }, null, 2)}\n`));
  const templates = new Map();
  for (const name of skill) templates.set(name, await regularFile(path.join(source, 'skills/ai-commerce', name)));
  const executable = await regularFile(process.execPath);
  const digest = createHash('sha256');
  for (const [name, bytes] of [...sourceFiles, ...templates]) digest.update(name).update('\0').update(bytes).update('\0');
  digest.update(hash(executable));
  digest.update(JSON.stringify(installation));
  const identity = digest.digest('hex');
  const root = path.join(home, '.local/share/ai-commerce');
  const directory = path.join(root, 'versions', `${pkg.version}-${identity.slice(0, 16)}`);
  const node = path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
  const launcher = path.join(directory, 'launcher.mjs');
  sourceFiles.set(path.basename(node), executable);
  // Same process preserves explicitly inherited secret descriptors and signals.
  sourceFiles.set('launcher.mjs', Buffer.from("await import('./bin/ai-commerce.mjs');\n"));
  for(const [name,bytes] of templates)sourceFiles.set(`.skill-templates/${name}`,bytes);
  const marker = Buffer.from(`${JSON.stringify({ source: SOURCE, version: pkg.version, sha256: identity, runtime: { version: process.versions.node, sha256: hash(executable) },installation,files:Object.fromEntries([...sourceFiles].map(([name,bytes])=>[name,hash(bytes)])) })}\n`);
  sourceFiles.set('.ai-commerce-install.json', marker);
  const registeredFiles = new Map([...templates].map(([name, bytes]) => [name, Buffer.from(bytes.toString().replaceAll('{{AI_COMMERCE_COMMAND}}', JSON.stringify([node, launcher])))]));
  registeredFiles.set('.ai-commerce-install.json', marker);
  await safePath(root, { create: true });
  if(await exists(path.join(root,'update-transaction.json')))throw new UpdateRecoveryError();
  const lock = path.join(root, '.install-lock');
  try { await mkdir(lock, { mode: 0o700 }); } catch { throw new Error(`Install already running or stale lock: ${lock}`); }
  try {
    // Preflight all targets before creating either registration.
    const toolExists = await checkDestination(directory, sourceFiles);
    const present = [],old=[];
    for (const target of targets) {
      await safePath(path.dirname(target));
      try{present.push(await checkDestination(target, registeredFiles));old.push(null);}
      catch(error){if(!upgrade)throw error;old.push(await validateOwned(target,home));present.push(false);}
    }
    if (!toolExists) await publish(directory, sourceFiles);
    try{
      const checked=await promisify(execFile)(node,[launcher,'--help'],{timeout:10000,maxBuffer:131072,windowsHide:true,shell:false});
      if(JSON.parse(checked.stdout).ok!==true)throw Error();
    }catch{throw Error('Installed launcher offline smoke check failed');}
    // Stages live alongside targets so directory renames stay on one filesystem.
    const changes=[];let journalOwned=false;
    try{
      for(let i=0;i<targets.length;i++)if(!present[i]){
        await safePath(path.dirname(targets[i]),{create:true});
        const stage=await mkdtemp(path.join(path.dirname(targets[i]),'.ai-commerce-stage-'));
        const files=path.join(stage,'skill');await publish(files,registeredFiles);
        changes.push({target:targets[i],stage,files,backup:path.join(stage,'previous'),hadOld:!!old[i],moved:false,switched:false});
      }
      // A durable journal retains the exact recoverable directories after a hard interruption.
      const journal=path.join(root,'update-transaction.json');
      if(await exists(journal))throw new UpdateRecoveryError();
      if(changes.length){await writeFile(journal,JSON.stringify(changes),{flag:'wx',mode:0o600});journalOwned=true;}
      for(const change of changes){
        if(change.hadOld){await validateOwned(change.target,home);await rename(change.target,change.backup);change.moved=true;}
        else if(await exists(change.target))throw Error('Installation collision');
        await rename(change.files,change.target);change.switched=true;
      }
      if(changes.length)await rm(journal);
    }catch(error){
      let recovered=true;
      for(const change of [...changes].reverse())try{
        if(change.switched)await rename(change.target,change.files);
        if(change.moved)await rename(change.backup,change.target);
      }catch{recovered=false;}
      if(!recovered)throw new UpdateRecoveryError();
      // Only remove the journal we own, not an earlier interrupted transaction.
      const journal=path.join(root,'update-transaction.json');
      if(journalOwned)await rm(journal,{force:true});
      for(const change of changes)if(!change.moved||await exists(change.target))await rm(change.stage,{recursive:true,force:true});
      throw error;
    }
    // Keep original registrations as rollback material; new runtime versions remain intact.
    for(const change of changes)if(!change.hadOld)await rm(change.stage,{recursive:true,force:true});
    return { ok: true, directory, node, launcher, skills: targets };
  } finally { await rmdir(lock); }
}

async function validateOwned(target,home){
  const actual=await inspectTree(target),markerBytes=actual.get('.ai-commerce-install.json');
  if(!markerBytes)throw Error('Installation collision: unowned registration');
  const marker=JSON.parse(markerBytes);
  if(marker.source!==SOURCE||!/^\d+\.\d+\.\d+$/.test(marker.version)||!/^[a-f0-9]{64}$/.test(marker.sha256))throw Error('Installation collision: invalid marker');
  const runtime=path.join(home,'.local/share/ai-commerce/versions',`${marker.version}-${marker.sha256.slice(0,16)}`);
  const installed=await inspectTree(runtime);
  if(!installed.get('.ai-commerce-install.json')?.equals(markerBytes))throw Error('Installation collision: marker mismatch');
  const node=path.join(runtime,process.platform==='win32'?'node.exe':'node'),invocation=JSON.stringify([node,path.join(runtime,'launcher.mjs')]);
  const expected=new Map();
  if(marker.files){
    if(installed.size!==Object.keys(marker.files).length+1)throw Error('Installation collision: modified runtime');
    for(const [name,sum] of Object.entries(marker.files))if(!installed.has(name)||hash(installed.get(name))!==sum)throw Error('Installation collision: modified runtime');
    for(const [name,bytes] of installed)if(name.startsWith('.skill-templates/'))expected.set(name.slice(17),Buffer.from(bytes.toString().replaceAll('{{AI_COMMERCE_COMMAND}}',invocation)));
  }else{
    // Explicit migration from 0.3.x: reconstruct its original digest, not just its marker.
    const digest=createHash('sha256');
    if(installed.size!==legacyPayload.length+3)throw Error('Installation collision: modified legacy runtime');
    for(const name of legacyPayload){const bytes=installed.get(name);if(!bytes)throw Error('Installation collision');digest.update(name).update('\0').update(bytes).update('\0');}
    for(const name of ['SKILL.md','references/setup.md','references/commands.md']){const bytes=actual.get(name);if(!bytes)throw Error('Installation collision');const template=Buffer.from(bytes.toString().replaceAll(invocation,'{{AI_COMMERCE_COMMAND}}'));digest.update(name).update('\0').update(template).update('\0');expected.set(name,bytes);}
    const binary=installed.get(path.basename(node));if(!binary||hash(binary)!==marker.runtime?.sha256||installed.get('launcher.mjs')?.toString()!=="await import('./bin/ai-commerce.mjs');\n")throw Error('Installation collision');
    digest.update(hash(binary));if(digest.digest('hex')!==marker.sha256)throw Error('Installation collision: modified legacy files');
  }
  expected.set('.ai-commerce-install.json',markerBytes);
  if(!sameFiles(actual,expected))throw Error('Installation collision: modified skill');
  return marker;
}
