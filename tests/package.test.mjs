import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..', import.meta.url));

test('source validation succeeds without installing dependencies or accessing credentials',()=>{
  const result=spawnSync(process.execPath,['scripts/verify.mjs'],{cwd:root,encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/source checks passed/i);
});

test('package has an explicit nonpublishing staging gate and no install hooks',async()=>{
  const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(pkg.private,true);
  assert.equal(pkg.bin['ai-commerce'],'bin/ai-commerce.mjs');
  assert.deepEqual(pkg.dependencies??{},{});
  for(const name of ['preinstall','install','postinstall','prepare','prepublishOnly']){
    assert.equal(pkg.scripts?.[name],undefined,`unexpected lifecycle hook ${name}`);
  }
});
