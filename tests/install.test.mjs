import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, lstat, unlink, rm, open, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {documentedInvocation} from './fixtures/invocation.mjs';

const installer = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
// A fixture CLI keeps installer tests independent of concurrent CLI implementation.
async function sandbox(t) {
  const temporaryRoot=await realpath(tmpdir());
  const base = await mkdtemp(path.join(temporaryRoot, 'ai commerce install '));
  t.after(async () => {
    assert.equal(path.dirname(base), temporaryRoot);
    assert.ok(path.basename(base).startsWith('ai commerce install '));
    await rm(base, { recursive: true, force: true });
  });
  const source = path.join(base, 'source tree');
  const home = path.join(base, 'fresh home');
  for (const dir of ['bin', 'cli/native', 'skills/ai-commerce/references']) await mkdir(path.join(source, dir), { recursive: true });
  await mkdir(home);
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'ai-commerce-skill', version: '0.1.0', type: 'module' }));
  await writeFile(path.join(source, 'bin/ai-commerce.mjs'), 'import {readFileSync} from "node:fs";\nconst args=process.argv.slice(2); const fd=args.indexOf("--passphrase-fd");\nconsole.log(JSON.stringify({ok:true,data:{args,...(fd>=0?{received:readFileSync(Number(args[fd+1]),"utf8")==="fixture-only-passphrase"}:{})}}));\n');
  for (const name of ['storage', 'secret-store', 'platform-storage', 'crypto', 'http', 'workflow', 'errors', 'app']) await writeFile(path.join(source, `cli/${name}.mjs`), 'export {};\n');
  await writeFile(path.join(source, 'cli/native/windows-storage.ps1'), '# fixture helper\n');
  await writeFile(path.join(source, 'cli/native/read-passphrase.mjs'), 'export {};\n');
  await writeFile(path.join(source, 'skills/ai-commerce/SKILL.md'), '---\nname: ai-commerce\ndescription: Use AI Commerce\n---\nRun {{AI_COMMERCE_COMMAND}}\n');
  for (const name of ['setup', 'commands']) await writeFile(path.join(source, `skills/ai-commerce/references/${name}.md`), `# ${name}\n`);
  await writeFile(path.join(source, 'secret.txt'), 'DO NOT COPY');
  return { base, source, home };
}
function install(s, args = []) {
  return spawnSync(process.execPath, [installer, '--agent', 'both', '--home', s.home, '--source', s.source, ...args], { encoding: 'utf8' });
}
function result(run) { assert.equal(run.status, 0, run.stderr); return JSON.parse(run.stdout); }

test('installation metadata identifies the tool without recording a hosting URL', async t => {
  const s=await sandbox(t),out=result(install(s));
  const marker=JSON.parse(await readFile(path.join(out.directory,'.ai-commerce-install.json'),'utf8'));
  assert.equal(marker.source,'ai-commerce-skill');
  for(const skill of out.skills)assert.equal(JSON.parse(await readFile(path.join(skill,'.ai-commerce-install.json'),'utf8')).source,'ai-commerce-skill');
});

// Removing registration, launcher quoting or the allowlist breaks this observable installation.
test('installs both agents into fresh homes with spaces and executes the installed launcher', async t => {
  const s = await sandbox(t);
  const out = result(install(s));
  for (const dir of ['.agents', '.claude']) {
    const skill = await readFile(path.join(s.home, dir, 'skills/ai-commerce/SKILL.md'), 'utf8');
    assert.deepEqual(documentedInvocation(skill),[out.node,out.launcher]);
    assert.ok(!skill.includes('{{AI_COMMERCE_COMMAND}}'));
  }
  const run = spawnSync(out.node, [out.launcher, 'doctor', 'argument with spaces'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).data.args, ['doctor', 'argument with spaces']);
  assert.ok(!(await readdir(out.directory)).includes('secret.txt'));
  assert.equal(await readFile(path.join(out.directory, 'cli/native/windows-storage.ps1'), 'utf8'), '# fixture helper\n');
  const marker = JSON.parse(await readFile(path.join(out.directory, '.ai-commerce-install.json'), 'utf8'));
  assert.equal(marker.runtime.version, process.versions.node);
  assert.match(marker.runtime.sha256, /^[a-f0-9]{64}$/);
});

test('documented invocation round-trips Windows backslashes, spaces and Unicode on every platform',()=>{
 const command=[path.win32.join('C:\\Program Files','Node.js','node.exe'),path.win32.join('C:\\Users','Тестовый пользователь','AI Commerce','launcher.mjs')];
 const text='Run `'+JSON.stringify(command)+'` with command arguments appended.';
 assert.deepEqual(documentedInvocation(text),command);
 assert.throws(()=>documentedInvocation('Run [not valid JSON]'));
});

test('reinstallation is idempotent and preserves unrelated skills and state', async t => {
  const s = await sandbox(t);
  await mkdir(path.join(s.home, '.agents/skills/unrelated'), { recursive: true });
  await writeFile(path.join(s.home, '.agents/skills/unrelated/note'), 'keep');
  await mkdir(path.join(s.home, '.config/ai-commerce'), { recursive: true });
  await writeFile(path.join(s.home, '.config/ai-commerce/vault'), 'keep encrypted state');
  const first = result(install(s));
  assert.deepEqual(result(install(s)), first);
  assert.equal(await readFile(path.join(s.home, '.agents/skills/unrelated/note'), 'utf8'), 'keep');
  assert.equal(await readFile(path.join(s.home, '.config/ai-commerce/vault'), 'utf8'), 'keep encrypted state');
});

test('existing unowned skill collision fails before installing either agent', async t => {
  const s = await sandbox(t);
  const existing = path.join(s.home, '.claude/skills/ai-commerce');
  await mkdir(existing, { recursive: true });
  await writeFile(path.join(existing, 'SKILL.md'), 'user skill');
  const run = install(s);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /collision/);
  assert.equal(await readFile(path.join(existing, 'SKILL.md'), 'utf8'), 'user skill');
  await assert.rejects(lstat(path.join(s.home, '.agents/skills/ai-commerce')), { code: 'ENOENT' });
});

test('symlink destination parent is rejected without writing outside the requested home', async t => {
  const s = await sandbox(t);
  const outside = path.join(s.base, 'outside');
  await mkdir(outside);
  await symlink(outside, path.join(s.home, '.agents'), 'dir');
  assert.match(install(s).stderr, /symlink/);
  assert.deepEqual(await readdir(outside), []);
});

test('symlink source and malformed version traversal fail closed', async t => {
  const s = await sandbox(t);
  await writeFile(path.join(s.source, 'package.json'), JSON.stringify({ name: 'ai-commerce-skill', version: '../../escape' }));
  assert.match(install(s).stderr, /Invalid package identity or version/);
  await writeFile(path.join(s.source, 'package.json'), JSON.stringify({ name: 'ai-commerce-skill', version: '0.1.0' }));
  await symlink(path.join(s.base, 'missing'), path.join(s.source, 'cli/extra.mjs'));
  // Unknown paths must never be copied, even a symlink outside the allowlist.
  const out = result(install(s));
  assert.ok(!(await readdir(path.join(out.directory, 'cli'))).includes('extra.mjs'));
});

test('allowlisted source symlink is rejected without installing anything', async t => {
  const s = await sandbox(t);
  const target = path.join(s.source, 'cli/storage.mjs');
  await unlink(target);
  await symlink(path.join(s.source, 'cli/app.mjs'), target);
  assert.match(install(s).stderr, /regular, unlinked file/);
  await assert.rejects(lstat(path.join(s.home, '.local')), { code: 'ENOENT' });
});

test('modified owned skill and modified installed launcher are never overwritten', async t => {
  const s = await sandbox(t);
  const first = result(install(s));
  const skill = path.join(first.skills[0], 'user-note');
  await writeFile(skill, 'valuable unrelated note');
  assert.match(install(s).stderr, /collision/);
  assert.equal(await readFile(skill, 'utf8'), 'valuable unrelated note');
  await unlink(skill);
  await writeFile(first.launcher, 'custom launcher');
  assert.match(install(s).stderr, /collision/);
  assert.equal(await readFile(first.launcher, 'utf8'), 'custom launcher');
});

test('native POSIX bootstrap uses supported Node offline', { skip: process.platform === 'win32' }, async t => {
  const s = await sandbox(t);
  const executables = path.join(s.base, 'node path');
  await mkdir(executables);
  await symlink(process.execPath, path.join(executables, 'node'));
  const bootstrap = fileURLToPath(new URL('../scripts/install.sh', import.meta.url));
  const run = spawnSync('sh', [bootstrap, '--agent', 'codex', '--home', s.home, '--source', s.source], {
    env: { ...process.env, PATH: `${executables}${path.delimiter}${process.env.PATH}` }, encoding: 'utf8'
  });
  const out = result(run);
  const cli = spawnSync(out.node, [out.launcher, 'status'], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(cli.stdout).data.args, ['status']);
});

test('project scope registers only within the explicit project', async t => {
  const s = await sandbox(t);
  const project = path.join(s.base, 'project with spaces');
  await mkdir(project);
  result(install(s, ['--scope', 'project', '--project', project]));
  assert.ok((await lstat(path.join(project, '.agents/skills/ai-commerce/SKILL.md'))).isFile());
  await assert.rejects(lstat(path.join(s.home, '.agents')), { code: 'ENOENT' });
});

test('installed launcher preserves an explicitly inherited passphrase descriptor', async t => {
  const s = await sandbox(t);
  const out = result(install(s));
  const input = path.join(s.base, 'fixture secret');
  await writeFile(input, 'fixture-only-passphrase', { mode: 0o600 });
  const handle = await open(input, 'r');
  try {
    const run = spawnSync(out.node, [out.launcher, 'status', '--passphrase-fd', '3'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', handle.fd] });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).data.received, true);
    assert.ok(!run.stdout.includes('fixture-only-passphrase'));
  } finally { await handle.close(); }
});

test('POSIX bootstrap rejects downloaded bytes with a mismatching pinned checksum', { skip: process.platform === 'win32' }, async t => {
  const s = await sandbox(t);
  const executables = path.join(s.base, 'fake transport');
  await mkdir(executables);
  await writeFile(path.join(executables, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  await writeFile(path.join(executables, 'curl'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then shift; output=$1; fi; shift; done\nprintf "not the official runtime" > "$output"\n', { mode: 0o700 });
  const bootstrap = fileURLToPath(new URL('../scripts/install.sh', import.meta.url));
  const run = spawnSync('sh', [bootstrap, '--agent', 'codex', '--home', s.home, '--source', s.source], {
    env: { ...process.env, PATH: `${executables}${path.delimiter}${process.env.PATH}` }, encoding: 'utf8'
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Runtime checksum mismatch; nothing was extracted/);
  assert.deepEqual(await readdir(s.home), []);
});

test('POSIX bootstrap extracts only verified executable and ignores unselected archive links', { skip: process.platform === 'win32' }, async t => {
  const s = await sandbox(t);
  const platform = `${process.platform}-${process.arch}`;
  const top = `node-v24.22.1-${platform}`;
  const archive = path.join(s.base, 'fixture.tar.gz');
  const runtime = path.join(s.base, 'runtime fixture', top, 'bin');
  await mkdir(runtime, { recursive: true });
  // Mimic official tarballs' npm symlink. This entry must never be extracted.
  await symlink('/not-extracted', path.join(runtime, 'npm'));
  await writeFile(path.join(runtime, 'node'), `#!/bin/sh\n[ ! -L "$(dirname "$0")/npm" ] || exit 8\nexec "${process.execPath}" "$@"\n`, { mode: 0o700 });
  const tar = spawnSync('tar', ['-czf', archive, '-C', path.join(s.base, 'runtime fixture'), top], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  const scripts = path.join(s.base, 'bootstrap fixture');
  await mkdir(scripts);
  await writeFile(path.join(scripts, 'install.sh'), await readFile(new URL('../scripts/install.sh', import.meta.url)));
  const checksum = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(path.join(scripts, 'runtime-manifest.json'), `{"platforms":{\n  "${platform}": { "file": "${top}.tar.gz", "sha256": "${checksum}" }\n}}\n`);
  await writeFile(path.join(scripts, 'install.mjs'), 'console.log(JSON.stringify({ok:true,args:process.argv.slice(2)}));\n');
  const executables = path.join(s.base, 'fake transport');
  await mkdir(executables);
  await writeFile(path.join(executables, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  await writeFile(path.join(executables, 'curl'), `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then shift; output=$1; fi; shift; done\ncp "${archive}" "$output"\n`, { mode: 0o700 });
  const run = spawnSync('sh', [path.join(scripts, 'install.sh'), '--agent', 'codex'], {
    env: { ...process.env, PATH: `${executables}${path.delimiter}${process.env.PATH}` }, encoding: 'utf8'
  });
  assert.deepEqual(result(run).args, ['--agent', 'codex']);
});
