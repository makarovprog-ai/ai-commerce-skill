import {readFile,writeFile,mkdir,rename,rm,rmdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {safePath,regularFile} from '../scripts/lib/install.mjs';
import {latestRelease,compareVersions,validateOrigin} from '../scripts/lib/release.mjs';
import {updateInstalled} from '../scripts/lib/update.mjs';

export async function installedMetadata(directory){
  const raw=await regularFile(join(directory,'.ai-commerce-install.json'));if(raw.length>262144)throw Error('Invalid install metadata');
  const marker=JSON.parse(raw),config=marker.installation;
  if(marker.source!=='ai-commerce-skill'||!/^\d+\.\d+\.\d+$/.test(marker.version)||!config)throw Error('Not an update-enabled installation');
  validateOrigin(config.origin);return {...config,version:marker.version,directory};
}
export async function checkUpdate({root,load,latest=latestRelease,now=Date.now,explicit=false}={}){
  let lock,locked=false;
  try{
    const installed=await load();validateOrigin(installed.origin);
    await safePath(root,{create:true});lock=join(root,'.update-check-lock');
    try{await mkdir(lock,{mode:0o700});locked=true;}catch{return {status:'unavailable'};}
    const cachePath=join(root,'update-check.json');let cache={};
    try{const raw=await regularFile(cachePath);if(raw.length>8192)throw Error();cache=JSON.parse(raw);}
    catch(error){if(error.code!=='ENOENT')return {status:'unavailable'};}
    const at=now(),identity=`${installed.origin}\n${installed.version}`;
    if(cache.identity!==identity)cache={identity};
    const save=async()=>{const temp=join(root,`.update-check-${randomUUID()}`);try{await writeFile(temp,JSON.stringify(cache),{flag:'wx',mode:0o600});await rename(temp,cachePath);}finally{await rm(temp,{force:true});}};
    if(explicit||!Number.isFinite(cache.last_attempt_at)||at-cache.last_attempt_at>=86400000||at<cache.last_attempt_at){
      cache.last_attempt_at=at;cache.status='unavailable';delete cache.release;await save();
      try{const release=await latest(installed.origin);cache.release=release;cache.status=compareVersions(release.version,installed.version)>0?'available':'up_to_date';cache.last_success_at=at;}catch{}
      await save();
    }
    if(cache.status==='available'&&cache.release){
      const result={status:'available',current_version:installed.version,latest_version:cache.release.version};
      if(cache.notified_version!==cache.release.version){cache.notified_version=cache.release.version;await save();result.notice={code:'update_available',version:cache.release.version,message:`Доступна новая версия AI Commerce ${cache.release.version}. Можно обновить без повторного входа.`};}
      return result;
    }
    return cache.status==='up_to_date'?{status:'up_to_date',current_version:installed.version}:{status:'unavailable'};
  }catch{return {status:'unavailable'};}
  finally{if(locked)await rmdir(lock).catch(()=>{});}
}
export function installedUpdater(directory=fileURLToPath(new URL('..',import.meta.url))){
  const root=dirname(dirname(directory)),load=()=>installedMetadata(directory);
  return {check:(explicit=false)=>checkUpdate({root,load,explicit}),install:async()=>updateInstalled(await load())};
}
