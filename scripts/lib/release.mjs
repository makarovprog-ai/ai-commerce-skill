import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execute=promisify(execFile);
export const EXPLICIT_RELEASE_LOOKUP_MS=15000;
export function validateOrigin(value){
  if(typeof value!=='string'||value.length>2048||/[\s\x00-\x1f\x7f]/.test(value))throw Error('Invalid update source');
  if(/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_.\/-]+\.git$/.test(value)&&!value.includes('..'))return value;
  let u;try{u=new URL(value);}catch{throw Error('Invalid update source');}
  if(!['https:','ssh:'].includes(u.protocol)||u.password||u.search||u.hash||!u.hostname||!/^\/[A-Za-z0-9_.\/-]+$/.test(u.pathname)||u.pathname.includes('..')||(u.protocol==='https:'&&u.username)||(u.protocol==='ssh:'&&u.username!=='git'))throw Error('Invalid update source');
  return value;
}
export async function runGit(args,{cwd,timeout=3000}={}){
  const env={...process.env};
  for(const key of Object.keys(env))if(/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*|SSL_NO_VERIFY|TRACE.*)$/i.test(key))delete env[key];
  Object.assign(env,{GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never',GIT_SSH_COMMAND:'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes'});
  try{
    const {stdout}=await execute('git',['-c','core.hooksPath=/dev/null','-c','http.sslVerify=true','-c','http.followRedirects=false','-c','protocol.file.allow=never','-c','protocol.ext.allow=never',...args],{cwd,env,timeout,maxBuffer:4*1024*1024,encoding:'utf8',windowsHide:true,shell:false});
    return stdout;
  }catch{throw Error('Update source unavailable');}
}
export function compareVersions(a,b){const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]<y[i]?-1:1;return 0;}
export async function latestRelease(origin,{run=runGit,timeout=3000}={}){
  validateOrigin(origin);const text=await run(['ls-remote','--tags','--',origin,'refs/tags/v*'],{timeout});const releases=new Map();
  for(const line of text.split('\n')){const m=/^([a-f0-9]{40,64})\s+refs\/tags\/v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(\^\{\})?$/.exec(line);if(!m||m[2].split('.').some(n=>!Number.isSafeInteger(Number(n))))continue;
    if(!releases.has(m[2])||m[3])releases.set(m[2],{version:m[2],commit:m[1],tag:`v${m[2]}`});
  }
  const latest=[...releases.values()].sort((a,b)=>compareVersions(b.version,a.version))[0];if(!latest)throw Error('No stable release');return latest;
}
export async function sourceIdentity(source,{run=runGit}={}){
  try{return {origin:validateOrigin((await run(['config','--get','remote.origin.url'],{cwd:source})).trim()),commit:(await run(['rev-parse','HEAD'],{cwd:source})).trim()};}catch{return {};}
}
