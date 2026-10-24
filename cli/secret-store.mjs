import {randomBytes,scrypt as scryptCallback,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import {constants,fstat} from 'node:fs';
import {isAbsolute,resolve,parse,join,sep} from 'node:path';
import {ClientError} from './errors.mjs';
import {nativeRun,windowsNative,windowsExecutable,readPrivate,atomicPrivate,unsafe} from './platform-storage.mjs';

const scrypt=promisify(scryptCallback);
const unavailable=()=>new ClientError('secret_provider_unavailable');
const validId=id=>typeof id==='string'&&/^[0-9a-f]{64}$/.test(id);
function decodeKey(value) {if(!/^[0-9a-f]{64}$/.test(value))throw unavailable();return Buffer.from(value,'hex');}

async function directoryCapability(directory) {
  const failure={status:'unavailable',permissions:'not_checked'};
  if(typeof directory!=='string'||!isAbsolute(directory)||resolve(directory)!==directory||directory===parse(directory).root)return failure;
  let cursor=parse(directory).root;
  try {
    for(const part of directory.slice(cursor.length).split(sep).filter(Boolean)) {
      cursor=join(cursor,part);let info;
      try{info=await fs.lstat(cursor);}catch(error){if(error.code==='ENOENT')return {status:'not_created',permissions:'not_checked'};throw error;}
      if(!info.isDirectory()||info.isSymbolicLink())return failure;
      if(process.platform!=='win32') {
        const uid=process.geteuid?.();if(uid===undefined||![0,uid].includes(info.uid))return failure;
        if((info.mode&0o022)!==0&&!(cursor!==directory&&info.uid===0&&(info.mode&0o1000)!==0))return failure;
        if(cursor===directory&&(info.uid!==uid||(info.mode&0o777)!==0o700))return failure;
      }
    }
    return {status:'present',permissions:process.platform==='win32'?'not_checked':'verified'};
  }catch{return failure;}
}

async function prerequisite(name,path,executable=false) {
  try {
    const entry=await fs.lstat(path);if(!entry.isFile()||entry.isSymbolicLink())throw Error();
    if(executable)await fs.access(path,constants.X_OK);
    return {name,status:'present'};
  }catch{return {name,status:'unavailable'};}
}

// Metadata-only inspection: never invoke a provider, read a vault, consume an FD,
// launch PowerShell, probe DBus, or trigger an OS unlock/authorization prompt.
export async function inspectSecretProvider({directory,passphraseFd,secretProvider,platform=process.platform}={}) {
  const result={backend:'unsupported',status:'unavailable',unlock:'not_checked',prerequisites:[],directory:await directoryCapability(directory),next_action:'Use a supported OS secure store or an approved inherited passphrase FD.'};
  if(passphraseFd!==undefined) {
    result.backend='passphrase_fd';let present=false;
    if(Number.isSafeInteger(passphraseFd)&&passphraseFd>=3)try{await promisify(fstat)(passphraseFd);present=true;}catch{}
    result.prerequisites=[{name:'inherited_fd',status:present?'present':'unavailable'}];
    result.status=present?'unlock_unverified':'unavailable';
    result.next_action=present?'FD metadata is present; passphrase validity was not tested or consumed. Supply the same passphrase through an approved inherited FD for authorization.':'Provide an already-open descriptor >=3 through an approved secret-input mechanism; never put a passphrase in argv or environment.';
  }else if(secretProvider) {
    result.backend='custom';result.status='not_checked';result.next_action='Custom provider was not invoked. Verify its secure custody through its approved setup workflow.';
  }else if(platform==='linux') {
    result.backend='linux_secret_service';result.prerequisites=[await prerequisite('secret_tool','/usr/bin/secret-tool',true)];
    result.status=result.prerequisites[0].status==='present'?'unlock_unverified':'unavailable';
    result.next_action=result.status==='unavailable'?'Ask the system administrator to provide secret-tool and a usable Secret Service, or use an approved inherited passphrase FD.':'secret-tool is present; Secret Service availability and unlock were not tested. Authorize only through the normal user-approved workflow.';
  }else if(platform==='darwin') {
    result.backend='macos_keychain';result.prerequisites=[await prerequisite('security_tool','/usr/bin/security',true)];
    result.status=result.prerequisites[0].status==='present'?'unlock_unverified':'unavailable';
    result.next_action=result.status==='unavailable'?'Ask the system administrator to restore the system Keychain security tool.':'Keychain tool is present; access and unlock were not tested. Use the normal user-approved authorization workflow.';
  }else if(platform==='win32') {
    result.backend='windows_dpapi';result.policy='not_checked';
    let executable;try{executable=windowsExecutable();}catch{}
    result.prerequisites=[executable?await prerequisite('powershell',executable,true):{name:'powershell',status:'unavailable'},await prerequisite('storage_helper',fileURLToPath(new URL('./native/windows-storage.ps1',import.meta.url)))];
    result.status=result.prerequisites.every(item=>item.status==='present')?'unlock_unverified':'unavailable';
    result.next_action='DPAPI, ACL checks and script policy were not exercised. Use an administrator-approved helper under existing host policy; never bypass execution policy.';
  }
  if(result.directory.status==='unavailable') {
    result.status='unavailable';result.next_action='Select a private, owned local state directory without links; do not change another application\'s data or weaken permissions.';
  }
  return result;
}

async function passphrase(fd) {
  if(!Number.isSafeInteger(fd)||fd<3)throw new ClientError('passphrase_required');
  let bytes;
  try{const result=await nativeRun(process.execPath,[fileURLToPath(new URL('./native/read-passphrase.mjs',import.meta.url))],'',{fd,timeout:5000});bytes=result.stdout;
    let value=bytes;if(value.at(-1)===10)value=value.subarray(0,-1);if(value.at(-1)===13)value=value.subarray(0,-1);
    if(value.length<12||value.length>4096||value.includes(0)||value.includes(10)||value.includes(13))throw new ClientError('passphrase_required');return Buffer.from(value);
  }catch{throw new ClientError('passphrase_required');}finally{bytes?.fill(0);}
}
export function createSecretProvider({directory,passphraseFd,platform=process.platform,run=nativeRun}={}) {
  let cached,cachedId;
  return {async get({id,create=false}) {
    if(!validId(id))throw unavailable();
    if(cached){if(cachedId!==id)throw unavailable();return Buffer.from(cached);}
    let key;
    if(passphraseFd!==undefined) {
      let data=await readPrivate(directory,'passphrase-salt.json'),salt;
      if(data){try{const obj=JSON.parse(data);if(obj.version!==1||Object.keys(obj).length!==2||!/^[0-9a-f]{64}$/.test(obj.salt))throw unsafe();salt=Buffer.from(obj.salt,'hex');}catch{throw unsafe();}}
      else{if(!create)return null;salt=randomBytes(32);await atomicPrivate(directory,'passphrase-salt.json',Buffer.from(JSON.stringify({version:1,salt:salt.toString('hex')})));}
      // Version 1 fixes scrypt at N=2^17, r=8, p=1 (128 MiB working memory).
      const password=await passphrase(passphraseFd);try{key=await scrypt(password,salt,32,{N:131072,r:8,p:1,maxmem:256*1024*1024});}finally{password.fill(0);}
    }else if(platform==='linux') {
      const lookup=await run('/usr/bin/secret-tool',['lookup','service','ai-commerce','account',id],'',{allowed:[0,1]});
      const existing=lookup.stdout.toString('utf8').trim();lookup.stdout.fill(0);
      if(lookup.code===0&&existing)key=decodeKey(existing);
      else{if(!create)throw unavailable();key=randomBytes(32);const stored=await run('/usr/bin/secret-tool',['store','--label=AI Commerce device vault','service','ai-commerce','account',id],key.toString('hex')+'\n');stored.stdout.fill(0);
        const check=await run('/usr/bin/secret-tool',['lookup','service','ai-commerce','account',id]);try{const actual=decodeKey(check.stdout.toString('utf8').trim());if(!timingSafeEqual(key,actual))throw unavailable();actual.fill(0);}finally{check.stdout.fill(0);}}
    }else if(platform==='darwin') {
      const args=['find-generic-password','-s','ai-commerce','-a',id,'-w'];
      const lookup=await run('/usr/bin/security',args,'',{allowed:[0,44]});
      const existing=lookup.stdout.toString('utf8').trim();lookup.stdout.fill(0);
      if(lookup.code===0)key=decodeKey(existing);
      else{if(!create)throw unavailable();key=randomBytes(32);
        // The command grammar contains only fixed words, a validated hex ID and hex key.
        // No password is ever in process argv; interactive diagnostics are discarded.
        const stored=await run('/usr/bin/security',['-i'],`add-generic-password -a ${id} -s ai-commerce -w ${key.toString('hex')}\n`);stored.stdout.fill(0);
        const check=await run('/usr/bin/security',args);try{if(check.code!==0)throw unavailable();const actual=decodeKey(check.stdout.toString('utf8').trim());if(!timingSafeEqual(key,actual))throw unavailable();actual.fill(0);}finally{check.stdout.fill(0);}}
    }else if(platform==='win32') {
      const data=await readPrivate(directory,'key.dpapi');
      if(data){const result=await windowsNative({operation:'unprotect',id,value:data.toString('utf8')});key=decodeKey(result.value);}
      else{if(!create)throw unavailable();key=randomBytes(32);const result=await windowsNative({operation:'seal',id,value:key.toString('hex')});if(typeof result.value!=='string'||!/^[A-Za-z0-9+/]+=*$/.test(result.value))throw unavailable();await atomicPrivate(directory,'key.dpapi',Buffer.from(result.value));}
    }else throw unavailable();
    if(!Buffer.isBuffer(key)||key.length!==32)throw unavailable();cached=Buffer.from(key);cachedId=id;return key;
  }};
}
