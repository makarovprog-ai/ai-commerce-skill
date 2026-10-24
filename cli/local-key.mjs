import {randomBytes} from 'node:crypto';
import {open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {ClientError} from './errors.mjs';
import {readPrivate,inspectDirectory,protect,unsafe} from './platform-storage.mjs';

export const LOCAL_KEY_FILE='key.local.json';
export const nativeStoreName=platform=>({linux:'Secret Service',darwin:'Keychain',win32:'DPAPI'}[platform]??'Системное хранилище ОС');
export function localStorageNotice(platform,reason='active') {
  const name=nativeStoreName(platform);
  return {code:'local_key_storage',native_store:name,backend:'local_file',
    message:reason==='unavailable'?`${name} недоступен. Продолжим с локальным ключом, доступ к которому ограничен вашей учётной записью. Дополнительная настройка не нужна.`:`Для этого подключения используется локальный ключ вместо ${name}. Можно продолжать работу как обычно.`};
}
export async function localKey(directory,id,{create=false}={}) {
  if(!directory)return null;
  const bytes=await readPrivate(directory,LOCAL_KEY_FILE);
  if(bytes){try{const d=JSON.parse(bytes);if(!d||Object.keys(d).length!==3||d.version!==1||d.id!==id||!/^[0-9a-f]{64}$/.test(d.key))throw unsafe();return Buffer.from(d.key,'hex');}catch{throw unsafe();}finally{bytes.fill(0);}}
  if(!create)return null;
  // Never reinterpret inaccessible existing custody as a new empty vault.
  for(const name of ['vault.json','key.dpapi','passphrase-salt.json','sign.json','wrap.json','session.json']){
    if(await readPrivate(directory,name))throw new ClientError('secret_provider_unavailable');
  }
  await inspectDirectory(directory);
  const path=join(directory,LOCAL_KEY_FILE),key=randomBytes(32);let file;
  try{
    // Exclusive creation: a racing initializer cannot replace the master key.
    file=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW??0),0o600);
    await protect(path);await file.writeFile(JSON.stringify({version:1,id,key:key.toString('hex')}));await file.sync();await file.close();file=null;
    if(process.platform!=='win32'){const dir=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|(constants.O_NOFOLLOW??0));try{await dir.sync();}finally{await dir.close();}}
    const checked=await localKey(directory,id);try{if(!checked||!checked.equals(key))throw unsafe();}finally{checked?.fill(0);}
    return key;
  }catch(error){key.fill(0);if(error instanceof ClientError)throw error;throw unsafe();}
  finally{await file?.close();}
}
