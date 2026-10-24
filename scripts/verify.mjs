import {readFile,readdir,lstat} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const fail=message=>{throw new Error(message);};
const pkg=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
if(Number(process.versions.node.split('.')[0])!==24)fail('Node.js 24 LTS is required');
if(pkg.private!==true)fail('Publication gate must remain closed until testing approval');
if(Object.keys(pkg.dependencies??{}).length)fail('Unexpected runtime dependencies');
for(const name of ['preinstall','install','postinstall','prepare']){
  if(pkg.scripts?.[name])fail(`Unexpected lifecycle hook: ${name}`);
}
for(const name of ['bin/ai-commerce.mjs','README.md','SECURITY.md','skills/ai-commerce/SKILL.md','scripts/install.mjs']){
  if(!(await lstat(resolve(root,name))).isFile())fail(`Missing distribution file: ${name}`);
}
const skip=new Set(['.git','node_modules','.superpowers','coverage','dist']);
const files=[];
async function walk(directory){
  for(const name of await readdir(directory)){
    if(skip.has(name))continue;
    const path=resolve(directory,name),stat=await lstat(path);
    if(stat.isSymbolicLink())fail(`Symlink in source artifact: ${relative(root,path)}`);
    if(stat.isDirectory())await walk(path);
    else if(stat.isFile())files.push(path);
  }
}
await walk(root);
for(const path of files){
  if(!/\.(?:mjs|json|md|ya?ml|sh|ps1)$/.test(path))continue;
  const text=await readFile(path,'utf8');
  if(path.endsWith('.mjs')){
    const result=spawnSync(process.execPath,['--check',path],{encoding:'utf8',timeout:15000});
    if(result.status!==0)fail(`JavaScript syntax error in ${relative(root,path)}`);
  }
  if(/\/root\/(?:codex-workspaces|\.config\/codex-cto)/.test(text))fail(`Internal deployment path in ${relative(root,path)}`);
  if(/-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(text))fail(`Private-key literal in ${relative(root,path)}`);
  if(/\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/.test(text))fail(`Credential literal in ${relative(root,path)}`);
  if(/\u043a\u043e\u043c\u043f\u0430\u043d\u044c\u043e\u043d/iu.test(text))fail(`Unsupported public terminology in ${relative(root,path)}`);
}
const skill=await readFile(resolve(root,'skills/ai-commerce/SKILL.md'),'utf8');
if(!/^---\r?\n/.test(skill)||!/^name:\s*ai-commerce\s*$/m.test(skill)||!/^description:\s*\S/m.test(skill))fail('Invalid skill metadata');
if(skill.length>8000)fail('Skill entrypoint is too large; move detail into references');
console.log(`AI Commerce source checks passed (${files.length} files).`);
