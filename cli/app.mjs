import {open,readFile,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,parse,join,sep} from 'node:path';
import {windowsNative} from './platform-storage.mjs';
import {CommerceClient} from './workflow.mjs';
import {BASE} from './crypto.mjs';
import {ClientError,publicError,diagnosticError,httpError} from './errors.mjs';
import {assertEnvironment,requestJSON,publicPeer} from './http.mjs';
import {readToolSnapshot,selectTools,mcpPhase} from './tool-discovery.mjs';
import {installedUpdater} from './updates.mjs';
import {UpdateRecoveryError} from '../scripts/lib/install.mjs';

const MAX_INPUT=262144;
const MAX_SNAPSHOT=8*1024*1024;
const invalidInput=()=>new ClientError('invalid_request');
function regularInput(info,maxBytes) {
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>maxBytes||!Number.isFinite(info.ino)||info.ino===0||!Number.isFinite(info.dev))throw invalidInput();
  return info;
}
async function inputMetadata(path,maxBytes) {
  let current=parse(path).root,leaf;
  for(const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current=join(current,part);const info=await lstat(current);
    if(info.isSymbolicLink()||(current!==path&&!info.isDirectory()))throw invalidInput();
    if(current===path)leaf=regularInput(info,maxBytes);
  }
  if(!leaf)throw invalidInput();
  // Native attributes catch Windows reparse points that may not present as a
  // POSIX-style symlink; the helper inspects metadata only under host policy.
  if(process.platform==='win32'&&(await windowsNative({operation:'input',path})).ok!==true)throw invalidInput();
  return leaf;
}
function sameInput(before,after,maxBytes) {
  regularInput(after,maxBytes);if(before.ino!==after.ino||before.dev!==after.dev)throw invalidInput();
}
export async function readRaw(path='-',input=process.stdin,signal,{timeoutMs=15000,maxBytes=MAX_INPUT}={}) {
  let handle,timer,inputPath,before;
  const cancel=()=>input.destroy(new ClientError('cancelled'));
  try {
    if(signal?.aborted)throw new ClientError('cancelled');
    if(path!=='-') {
      inputPath=resolve(path);before=await inputMetadata(inputPath,maxBytes);
      handle=await open(inputPath,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
      sameInput(before,await handle.stat(),maxBytes);sameInput(before,await inputMetadata(inputPath,maxBytes),maxBytes);
      input=handle.createReadStream({autoClose:false});
    }
    signal?.addEventListener('abort',cancel,{once:true});
    timer=setTimeout(()=>input.destroy(new ClientError('invalid_request')),timeoutMs);
    let size=0;const chunks=[];
    for await(const chunk of input){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>maxBytes)throw invalidInput();chunks.push(bytes);}
    if(handle){sameInput(before,await handle.stat(),maxBytes);sameInput(before,await inputMetadata(inputPath,maxBytes),maxBytes);}
    return Buffer.concat(chunks,size);
  } catch(error) { throw error instanceof ClientError?error:new ClientError('invalid_request'); }
  finally {clearTimeout(timer);signal?.removeEventListener('abort',cancel);await handle?.close();}
}

const secretKey=/^(?:access_token|refresh_token|id_token|client_secret|private_key|private_jwk|signing_input|signing_proof|wrapping_proof|wrapped_dek|encrypted_dek|wrapping_context|wrapped_key|ciphertext|sign_jwk|wrap_jwk|dpop|authorization|code_verifier)$/i;
function publicData(value) {
  if(Array.isArray(value))return value.map(publicData);
  if(value&&typeof value==='object'&&value.kty&&value.d)return '[redacted]';
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!secretKey.test(k)).map(([k,v])=>[k,publicData(v)]));
  if(typeof value==='string'&&/^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value))return '[redacted]';
  return value;
}
const usage='AI Commerce (Node24)\nUsage: ai-commerce <login|status|session|refresh|logout|doctor|tools|mcp> [--profile mcp|diagnostic] [--state-dir PATH] [--passphrase-fd FD]\n       ai-commerce mcp [--input PATH|-]\n       ai-commerce tools [--from PATH|-] [--summary | --name NAME]\n       ai-commerce doctor --network\n       ai-commerce update <check|install>\nDefault profile: mcp. Login: open the link, compare four symbols, approve; no credential input.\nstatus, plain doctor, and tools --from are offline. doctor --network uses one credential-free HTTPS probe.\nMCP sends original input bytes once; ambiguous results are never retried.\nlogout removes the local session only, retains device keys, and does not revoke server access.\nHeadless fallback: --passphrase-fd accepts a pre-opened descriptor >=3, never a passphrase argument.';
const versionInfo=async()=>JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;

async function networkDoctor(emit,transport,signal){
  const runtime={cli:await versionInfo(),node:process.versions.node};
  const probe={runtime,proxy_env_configured:Boolean(process.env.https_proxy||process.env.HTTPS_PROXY)};
  const time_utc=new Date().toISOString(),start=performance.now();
  try{
    const response=await transport(BASE+'/jwks',{method:'GET',signal,reportPeer:true});
    const tls=publicPeer(response.tls);
    if(!tls.verified)throw httpError('invalid_response',response,'network-probe');
    emit({ok:true,data:{...probe,network:{time_utc,http_status:response.status,tls,elapsed_ms:Math.floor(performance.now()-start)}}});
    return 0;
  }catch(error){
    emit({ok:false,error:publicError(diagnosticError(error instanceof ClientError?error:new ClientError('command_failed'),'network-probe')),probe});return 1;
  }
}
export async function main(args=process.argv.slice(2),dependencies={}) {
  const write=dependencies.write??(value=>process.stdout.write(value+'\n'));
  const notices=new Map();
  const emit=value=>write(JSON.stringify({version:1,...(notices.size?{notices:[...notices.values()]}:{}),...value}));
  let abort,stop;
  try {
    assertEnvironment();
    const [command,...rest]=args;
    if(command==='--version'&&!rest.length){emit({ok:true,data:{version:await versionInfo()}});return 0;}
    if((command==='--help'||command==='help')&&!rest.length){emit({ok:true,data:{usage}});return 0;}
    if(command==='update'){
      if(rest.length!==1||!['check','install'].includes(rest[0]))throw new ClientError('usage');
      const updater=dependencies.updates??installedUpdater();
      if(rest[0]==='check'){
        let data;try{data=await updater.check(true);}catch{data={status:'unavailable'};}
        const {notice,...safe}=data;emit({ok:true,data:safe});return 0;
      }
      try{
        const data=await updater.install();
        emit({ok:true,data:{...data,authorization:'unchanged',
          message:'Обновление не меняет сохранённую сессию. Повторно входить по Сбер ID из-за обновления не нужно.'}});
        return 0;
      }
      catch(error){
        emit({ok:false,error:error instanceof UpdateRecoveryError
          ?{code:'update_failed',reason:'recovery_required',next_action:'repair_installation',message:'Обновление прервано; восстановление установки не подтверждено. Сохраните журнал и резервные каталоги. До восстановления не запускайте новую установку или операции с заказами. Ключи и авторизация не изменялись.'}
          :{code:'update_failed',message:'Не удалось завершить обновление AI Commerce. Ключи и авторизация не изменялись. Проверьте установку перед повторным обновлением.'}});return 1;
      }
    }
    if(!['login','status','session','refresh','logout','doctor','tools','mcp'].includes(command))throw new ClientError('usage');
    const opts={};
    for(let i=0;i<rest.length;i++){
      const key=rest[i];if(Object.hasOwn(opts,key))throw new ClientError('usage');
      if(command==='tools'&&key==='--summary'){opts[key]=true;continue;}
      if(command==='doctor'&&key==='--network'){opts[key]=true;continue;}
      if(!['--state-dir','--profile','--passphrase-fd',...(command==='mcp'?['--input']:[]),...(command==='tools'?['--name','--from']:[])].includes(key)||!rest[i+1]||rest[i+1].startsWith('--'))throw new ClientError('usage');opts[key]=rest[++i];
    }
    if(opts['--summary']&&opts['--name'])throw new ClientError('usage');
    if(opts['--network']&&Object.keys(opts).length!==1)throw new ClientError('usage');
    const from=opts['--from'];
    if(from&&['--state-dir','--profile','--passphrase-fd'].some(key=>Object.hasOwn(opts,key)))throw new ClientError('usage');
    const profile=opts['--profile']??'mcp';
    if(!['mcp','diagnostic'].includes(profile)||(['mcp','tools'].includes(command)&&profile!=='mcp'))throw new ClientError('usage');
    if(opts['--passphrase-fd']!==undefined&&(!/^[1-9][0-9]*$/.test(opts['--passphrase-fd'])||!Number.isSafeInteger(Number(opts['--passphrase-fd']))||Number(opts['--passphrase-fd'])<3))throw new ClientError('usage');
    abort=new AbortController();stop=()=>abort.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
    const signal=dependencies.signal??abort.signal;
    if(opts['--network'])return await networkDoctor(emit,dependencies.transport??requestJSON,signal);
    const projection={summary:opts['--summary'],name:opts['--name']};
    if(from){
      const data=readToolSnapshot(await readRaw(from,dependencies.input??process.stdin,signal,{maxBytes:MAX_SNAPSHOT}));
      emit({ok:true,data:selectTools(data,projection)});return 0;
    }
    const storageOptions={...dependencies.storageOptions,...(opts['--passphrase-fd']!==undefined?{passphraseFd:Number(opts['--passphrase-fd'])}:{}),onNotice:notice=>{notices.set(notice.code,notice);dependencies.storageOptions?.onNotice?.(notice);}};
    const client=new CommerceClient({...dependencies,storageOptions,profile,directory:opts['--state-dir'],signal,output:value=>emit({ok:true,event:'login_required',data:{verification_uri:value.verification_uri,user_code:value.user_code}})});
    const body=command==='mcp'?await readRaw(opts['--input'],dependencies.input??process.stdin,signal):undefined;
    const result=command==='mcp'?await client.mcp(body):await client[command]();
    if(['tools','mcp','session','refresh'].includes(command))try{
      const checked=await (dependencies.updates??installedUpdater()).check();
      if(checked?.notice?.code==='update_available')notices.set('update_available',checked.notice);
    }catch{ /* Update checks must never change the commerce outcome. */ }
    if(command==='doctor'&&result.storage.status==='unavailable'&&result.storage.fallback?.notice)notices.set(result.storage.fallback.notice.code,result.storage.fallback.notice);
    if(['mcp','tools'].includes(command)){
      if(result.status<200||result.status>=300)throw httpError('remote_error',result,command==='tools'?'tools/list':mcpPhase(body));
      emit({ok:true,data:command==='tools'?selectTools(result.data,projection):publicData(result.data)});
    }else emit({ok:true,data:publicData(result)});
    return 0;
  }catch(error){emit({ok:false,error:publicError(error)});return 1;}
  finally{if(stop){process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}}
}
