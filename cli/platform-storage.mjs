import {constants} from 'node:fs';
import {lstat,open,mkdir,rename,unlink} from 'node:fs/promises';
import {resolve,join,parse,sep,isAbsolute,win32} from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ClientError} from './errors.mjs';

export const unsafe=()=>new ClientError('unsafe_storage');
// Never expose child errors: OS tools may include their secret stdin in diagnostics.
export function nativeRun(program,args,input='',{allowed=[0],timeout=15000,fd,env}={}) {
  if(typeof program!=='string'||!(isAbsolute(program)||win32.isAbsolute(program)))return Promise.reject(new ClientError('secret_provider_unavailable'));
  return new Promise((accept,reject)=>{
    const child=spawn(program,args,{stdio:['pipe','pipe','pipe',...(fd===undefined?[]:[fd])],windowsHide:true,shell:false,...(env?{env}:{})});
    const chunks=[];let size=0,done=false;
    const timer=setTimeout(()=>{child.kill();finish(false);},timeout);timer.unref();
    function finish(ok,code){if(done)return;done=true;clearTimeout(timer);if(ok)accept({code,stdout:Buffer.concat(chunks)});else{for(const b of chunks)b.fill(0);reject(new ClientError('secret_provider_unavailable'));}}
    child.on('error',()=>finish(false));child.stdin.on('error',()=>{});
    child.stdout.on('data',b=>{size+=b.length;if(size>131072){child.kill();finish(false);}else chunks.push(b);});
    child.stderr.on('data',()=>{});child.on('close',code=>finish(allowed.includes(code),code));child.stdin.end(input);
  });
}
export function windowsExecutable(systemRoot=process.env.SystemRoot) {
  if(typeof systemRoot!=='string'||!/^([A-Za-z]:\\)/.test(systemRoot)||win32.normalize(systemRoot)!==systemRoot||systemRoot===win32.parse(systemRoot).root)throw new ClientError('secret_provider_unavailable');
  return win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
}
export async function windowsNative(request) {
  const exe=windowsExecutable();
  const helper=fileURLToPath(new URL('./native/windows-storage.ps1',import.meta.url));
  // Node launched from pwsh inherits PS7's incompatible module search path.
  // Constrain ONLY this child; never mutate the user's shell or host policy.
  const env={...process.env};for(const name of Object.keys(env))if(name.toLowerCase()==='psmodulepath')delete env[name];
  env.PSModulePath=win32.join(win32.dirname(exe),'Modules');
  const result=await nativeRun(exe,['-NoLogo','-NoProfile','-NonInteractive','-File',helper],JSON.stringify(request),{env,allowed:[0,2]});
  if(result.code===2)throw unsafe();
  try{return JSON.parse(result.stdout.toString('utf8'));}catch{throw unsafe();}finally{result.stdout.fill(0);}
}
export async function protect(path) {if(process.platform==='win32')await windowsNative({operation:'protect',path});}
async function checkPermissions(path,entry,directory=false) {
  if(process.platform==='win32'){await windowsNative({operation:'check',path});return;}
  if(entry.uid!==process.geteuid()||(entry.mode&0o777)!==(directory?0o700:0o600))throw unsafe();
}
export async function inspectDirectory(directory,create=false) {
  if(typeof directory!=='string'||!directory||resolve(directory)!==directory||directory===parse(directory).root||directory.startsWith('\\\\'))throw unsafe();
  let path=parse(directory).root;
  for(const part of directory.slice(path.length).split(sep).filter(Boolean)) {
    path=join(path,part);
    if(['.git','node_modules','static','public','www','wwwroot'].includes(part.toLowerCase()))throw unsafe();
    let entry;try{entry=await lstat(path);}catch(error){if(error.code!=='ENOENT')throw unsafe();if(!create)return false;try{await mkdir(path,{mode:0o700});await protect(path);}catch(e){if(e.code!=='EEXIST')throw unsafe();}entry=await lstat(path);}
    if(!entry.isDirectory()||entry.isSymbolicLink())throw unsafe();
    if(process.platform!=='win32') {
      if(![0,process.geteuid()].includes(entry.uid))throw unsafe();
      // Root-owned sticky system temporary directories are safe ancestors, not vault roots.
      if((entry.mode&0o022)!==0&&!(path!==directory&&entry.uid===0&&(entry.mode&0o1000)!==0))throw unsafe();
    }
    if(path===directory)await checkPermissions(path,entry,true);
    else if(process.platform==='win32')await windowsNative({operation:'ancestor',path});
    try{const git=await lstat(join(path,'.git'));if(git.isFile()||git.isSymbolicLink())throw unsafe();await lstat(join(path,'.git','HEAD'));throw unsafe();}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  return true;
}
export async function readPrivate(directory,name) {
  if(!await inspectDirectory(directory))return null;
  const path=join(directory,name);let before;
  try{before=await lstat(path);}catch(e){if(e.code==='ENOENT')return null;throw unsafe();}
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>131072)throw unsafe();
  await checkPermissions(path,before);
  let handle;try{
    handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));const after=await handle.stat();
    if(after.ino!==before.ino||after.dev!==before.dev||after.nlink!==1||after.size>131072)throw unsafe();
    await checkPermissions(path,after);const bytes=await handle.readFile();if(bytes.length>131072)throw unsafe();return bytes;
  }catch{throw unsafe();}finally{await handle?.close();}
}
export async function atomicPrivate(directory,name,bytes) {
  if(!await inspectDirectory(directory))throw unsafe();await readPrivate(directory,name);
  const temp=join(directory,`.${name}.${randomBytes(16).toString('hex')}.tmp`);let handle;
  try {
    handle=await open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW??0),0o600);
    await protect(temp);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;
    await inspectDirectory(directory);await readPrivate(directory,name);await rename(temp,join(directory,name));
    if(process.platform!=='win32'){const dir=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|(constants.O_NOFOLLOW??0));try{await dir.sync();}finally{await dir.close();}}
  }catch(error){if(error instanceof ClientError)throw error;throw unsafe();}finally{await handle?.close();await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw unsafe();});}
}
