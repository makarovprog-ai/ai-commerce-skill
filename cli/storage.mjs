import {constants} from 'node:fs';
import {open,lstat,unlink} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {createHash,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {profile,decode,generateKeys,importKeys} from './crypto.mjs';
import {ClientError} from './errors.mjs';
import {createSecretProvider} from './secret-store.mjs';
import {inspectDirectory,readPrivate,atomicPrivate,protect,unsafe} from './platform-storage.mjs';
export {ClientError,createSecretProvider};

export function defaultDirectory() {
  if(process.platform==='win32')return join(process.env.LOCALAPPDATA||join(homedir(),'AppData','Local'),'AI Commerce');
  if(process.platform==='darwin')return join(homedir(),'Library','Application Support','AI Commerce');
  const xdg=process.env.XDG_CONFIG_HOME;return join(xdg&&isAbsolute(xdg)?xdg:join(homedir(),'.config'),'ai-commerce');
}
const exact=(value,names)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===names.length&&names.every(n=>Object.hasOwn(value,n));
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
function validateSession(state,keys,p) {
  const names=['version','client_id','sign_jkt','wrap_jkt','access_token','refresh_token','expires_at','user_id','device_id','grant_id','rotation_in_flight',...(p.scope==='mcp:invoke'?['family_id','packet_id','wrapped_dek','wrapping_context','dek_generation']:[])];
  if(!exact(state,names)||state.version!==1||state.client_id!==p.client||state.sign_jkt!==keys.signJkt||state.wrap_jkt!==keys.wrapJkt||typeof state.rotation_in_flight!=='boolean'||!Number.isSafeInteger(state.expires_at)||state.expires_at<=0||!['user_id','device_id','grant_id'].every(n=>uuid(state[n]))||typeof state.refresh_token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(state.refresh_token)||typeof state.access_token!=='string'||state.access_token.length>8192||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(state.access_token))throw unsafe();
  for(const part of state.access_token.split('.'))decode(part,8192);
  if(p.scope==='mcp:invoke'&&(!uuid(state.family_id)||!uuid(state.packet_id)||state.dek_generation!==1||decode(state.wrapped_dek).length!==keys.wrap.asymmetricKeyDetails.modulusLength/8||decode(state.wrapping_context).length>4096))throw unsafe();
  return state;
}
const recordName=name=>typeof name==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)&&!['writer.lock','vault.json','passphrase-salt.json','key.dpapi','__proto__','constructor','prototype'].includes(name);

export class Storage {
  constructor(directory=defaultDirectory(),profileName='mcp',options={}) {
    if(typeof directory!=='string'||!isAbsolute(directory)||resolve(directory)!==directory)throw unsafe();
    this.directory=directory;this.profile=profile(profileName);
    this.id=createHash('sha256').update(`ai-commerce-vault-v1\n${directory}\n${this.profile.client}`).digest('hex');
    this.provider=options.secretProvider??createSecretProvider({directory,passphraseFd:options.passphraseFd});
  }
  async withLock(callback,{create=true}={}) {
    if(!await inspectDirectory(this.directory,create))return callback(null);
    const path=join(this.directory,'writer.lock');let handle,inode;
    try{try{handle=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW??0),0o600);}catch(error){if(error.code==='EEXIST')throw new ClientError('storage_locked');throw unsafe();}
      await protect(path);inode=await handle.stat();return await callback(this);
    }finally{if(handle){await handle.close();const current=await lstat(path);if(!inode||current.ino!==inode.ino||current.dev!==inode.dev||current.nlink!==1||current.isSymbolicLink())throw unsafe();await unlink(path);}}
  }
  async vault() {
    // Existing unencrypted custody is never migrated implicitly or silently ignored.
    for(const name of ['sign.json','wrap.json','session.json']){try{await lstat(join(this.directory,name));throw unsafe();}catch(error){if(error.code!=='ENOENT')throw error;}}
    const bytes=await readPrivate(this.directory,'vault.json');if(!bytes)return {version:1,records:{}};
    let key,clear;
    try{const envelope=JSON.parse(bytes);if(!exact(envelope,['version','id','iv','ciphertext','tag'])||envelope.version!==1||envelope.id!==this.id||decode(envelope.iv).length!==12||decode(envelope.tag).length!==16||decode(envelope.ciphertext).length>65536)throw unsafe();
      key=await this.provider.get({id:this.id,create:false});if(!Buffer.isBuffer(key)||key.length!==32)throw unsafe();
      const cipher=createDecipheriv('aes-256-gcm',key,decode(envelope.iv));cipher.setAAD(Buffer.from(`ai-commerce-vault-v1:${this.id}`));cipher.setAuthTag(decode(envelope.tag));clear=Buffer.concat([cipher.update(decode(envelope.ciphertext)),cipher.final()]);
      const data=JSON.parse(clear);if(!exact(data,['version','records'])||data.version!==1||!data.records||typeof data.records!=='object'||Array.isArray(data.records)||Object.keys(data.records).some(n=>!recordName(n)))throw unsafe();return data;
    }catch(error){if(error instanceof ClientError&&error.code==='secret_provider_unavailable')throw error;throw unsafe();}finally{key?.fill(0);clear?.fill(0);}
  }
  async persist(data) {
    let key,clear;try{key=await this.provider.get({id:this.id,create:true});if(!Buffer.isBuffer(key)||key.length!==32)throw unsafe();clear=Buffer.from(JSON.stringify(data));if(clear.length>65536)throw unsafe();
      const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(`ai-commerce-vault-v1:${this.id}`));const encrypted=Buffer.concat([cipher.update(clear),cipher.final()]);
      await atomicPrivate(this.directory,'vault.json',Buffer.from(JSON.stringify({version:1,id:this.id,iv:iv.toString('base64url'),ciphertext:encrypted.toString('base64url'),tag:cipher.getAuthTag().toString('base64url')})));
    }finally{key?.fill(0);clear?.fill(0);}
  }
  async read(name) {if(!recordName(name))throw unsafe();const records=(await this.vault()).records;return Object.hasOwn(records,name)?records[name]:null;}
  async write(name,value) {if(!recordName(name)||!value||typeof value!=='object'||Array.isArray(value))throw unsafe();const data=await this.vault();data.records[name]=value;await this.persist(data);}
  async keys(create=false) {
    try{const data=await this.vault(),sign=data.records['sign.json'],wrap=data.records['wrap.json'];
      if(!sign&&!wrap){if(data.records['session.json'])throw unsafe();if(!create)return null;const keys=generateKeys();data.records['sign.json']={version:1,jkt:keys.signJkt,private_jwk:keys.sign.export({format:'jwk'})};data.records['wrap.json']={version:1,jkt:keys.wrapJkt,private_jwk:keys.wrap.export({format:'jwk'})};await this.persist(data);return keys;}
      if(!exact(sign,['version','jkt','private_jwk'])||!exact(wrap,['version','jkt','private_jwk'])||sign.version!==1||wrap.version!==1)throw unsafe();const keys=importKeys(sign.private_jwk,wrap.private_jwk);if(keys.signJkt!==sign.jkt||keys.wrapJkt!==wrap.jkt)throw unsafe();return keys;
    }catch(error){if(error instanceof ClientError)throw error;throw unsafe();}
  }
  async session(keys) {try{const state=await this.read('session.json');return state?validateSession(state,keys,this.profile):null;}catch(error){if(error instanceof ClientError)throw error;throw unsafe();}}
  async save(keys,state) {try{validateSession(state,keys,this.profile);}catch{throw unsafe();}await this.write('session.json',state);}
  async logout() {const data=await this.vault();if(Object.hasOwn(data.records,'session.json')){delete data.records['session.json'];await this.persist(data);}}
}
