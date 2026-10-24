#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { install } from './lib/install.mjs';

const options = { source: fileURLToPath(new URL('../', import.meta.url)), home: homedir(), scope: 'user', agent: 'codex' };
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('node scripts/install.mjs --agent codex|claude|both --scope user|project [--home PATH] [--project PATH] [--source PATH]');
  } else {
    const seen = new Set();
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i].slice(2);
      if (!args[i].startsWith('--') || !Object.hasOwn(options, key) && !['project'].includes(key) || seen.has(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid or repeated installer option. Use --help.');
      seen.add(key); options[key] = args[i + 1];
    }
    console.log(JSON.stringify(await install(options)));
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: { code: 'INSTALL_FAILED', message: error.message } }));
  process.exitCode = 1;
}
