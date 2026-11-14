import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {install,safePath,regularFile,UpdateRecoveryError} from './install.mjs';
import {latestRelease,runGit,compareVersions} from './release.mjs';

export async function updateInstalled(config,{latest=latestRelease,run=runGit}={}){
  const root=join(config.home,'.local/share/ai-commerce');await safePath(root);
  try{await regularFile(join(root,'update-transaction.json'));throw new UpdateRecoveryError();}catch(error){if(error.code!=='ENOENT')throw error;}
  const release=await latest(config.origin);
  if(compareVersions(release.version,config.version)<=0)return {status:'up_to_date',current_version:config.version};
  const stage=await mkdtemp(join(root,'.release-'));
  try{
    await run(['init','--quiet',stage],{timeout:10000});
    await run(['fetch','--quiet','--depth=1','--no-tags','--',config.origin,`refs/tags/${release.tag}`],{cwd:stage,timeout:60000});
    const commit=(await run(['rev-parse','FETCH_HEAD^{commit}'],{cwd:stage,timeout:5000})).trim();
    if(commit!==release.commit)throw Error('Release changed during download');
    await run(['-c','core.autocrlf=false','checkout','--quiet','--detach',commit],{cwd:stage,timeout:15000});
    const pkg=JSON.parse(await readFile(join(stage,'package.json'),'utf8'));
    if(pkg.version!==release.version||pkg.name!=='ai-commerce-skill')throw Error('Release identity mismatch');
    const out=await install({source:stage,home:config.home,project:config.project,scope:config.scope,agent:config.agent,upgrade:true,origin:config.origin,commit});
    return {status:'updated',version:release.version,...out};
  }finally{await rm(stage,{recursive:true,force:true}).catch(()=>{});}
}
