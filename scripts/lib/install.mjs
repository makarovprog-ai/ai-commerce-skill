import { lstat, readFile, readdir, mkdir, mkdtemp, writeFile, rename, rm, rmdir, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const SOURCE = 'ai-commerce-skill';
const payloadFiles = ['package.json', 'bin/ai-commerce.mjs', ...['storage', 'secret-store', 'local-key', 'platform-storage', 'crypto', 'http', 'workflow', 'errors', 'app'].map(n => `cli/${n}.mjs`), 'cli/native/windows-storage.ps1', 'cli/native/read-passphrase.mjs'];
const skillFiles = ['SKILL.md', 'references/setup.md', 'references/commands.md'];
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

async function regularFile(target) {
  await safePath(path.dirname(target));
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`Expected a regular, unlinked file: ${target}`);
  return readFile(target);
}

async function inspectTree(directory) {
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

async function publish(directory, files) {
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

export async function install({ source, home, project, scope = 'user', agent = 'codex' }) {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('AI Commerce requires Node.js 24 LTS. Use the local bootstrap.');
  if (!['codex', 'claude', 'both'].includes(agent)) throw new Error('Invalid agent; choose codex, claude or both.');
  if (!['user', 'project'].includes(scope)) throw new Error('Invalid scope; choose user or project.');
  if (scope === 'project' && !project) throw new Error('Project scope requires --project PATH.');
  source = await safePath(source);
  home = await safePath(home);
  const registerRoot = scope === 'project' ? await safePath(project) : home;
  const sourceFiles = new Map();
  for (const name of payloadFiles) sourceFiles.set(name, await regularFile(path.join(source, name)));
  const pkg = JSON.parse(sourceFiles.get('package.json'));
  if (pkg.name !== 'ai-commerce-skill' || !/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Invalid package identity or version.');
  // Copy a minimal ESM manifest, not package scripts, dependencies or private fields.
  sourceFiles.set('package.json', Buffer.from(`${JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module' }, null, 2)}\n`));
  const templates = new Map();
  for (const name of skillFiles) templates.set(name, await regularFile(path.join(source, 'skills/ai-commerce', name)));
  const executable = await regularFile(process.execPath);
  const digest = createHash('sha256');
  for (const [name, bytes] of [...sourceFiles, ...templates]) digest.update(name).update('\0').update(bytes).update('\0');
  digest.update(hash(executable));
  const identity = digest.digest('hex');
  const root = path.join(home, '.local/share/ai-commerce');
  const directory = path.join(root, 'versions', `${pkg.version}-${identity.slice(0, 16)}`);
  const node = path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
  const launcher = path.join(directory, 'launcher.mjs');
  const marker = Buffer.from(`${JSON.stringify({ source: SOURCE, version: pkg.version, sha256: identity, runtime: { version: process.versions.node, sha256: hash(executable) } })}\n`);
  sourceFiles.set(path.basename(node), executable);
  // Same process preserves explicitly inherited secret descriptors and signals.
  sourceFiles.set('launcher.mjs', Buffer.from("await import('./bin/ai-commerce.mjs');\n"));
  sourceFiles.set('.ai-commerce-install.json', marker);
  const registeredFiles = new Map([...templates].map(([name, bytes]) => [name, Buffer.from(bytes.toString().replaceAll('{{AI_COMMERCE_COMMAND}}', JSON.stringify([node, launcher])))]));
  registeredFiles.set('.ai-commerce-install.json', marker);
  const agents = agent === 'both' ? ['codex', 'claude'] : [agent];
  const targets = agents.map(a => path.join(registerRoot, a === 'codex' ? '.agents' : '.claude', 'skills/ai-commerce'));
  await safePath(root, { create: true });
  const lock = path.join(root, '.install-lock');
  try { await mkdir(lock, { mode: 0o700 }); } catch { throw new Error(`Install already running or stale lock: ${lock}`); }
  try {
    // Preflight all targets before creating either registration.
    const toolExists = await checkDestination(directory, sourceFiles);
    const present = [];
    for (const target of targets) { await safePath(path.dirname(target)); present.push(await checkDestination(target, registeredFiles)); }
    if (!toolExists) await publish(directory, sourceFiles);
    for (let i = 0; i < targets.length; i++) if (!present[i]) await publish(targets[i], registeredFiles);
    return { ok: true, directory, node, launcher, skills: targets };
  } finally { await rmdir(lock); }
}
