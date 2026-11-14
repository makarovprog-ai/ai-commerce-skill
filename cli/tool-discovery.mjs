import {ClientError} from './errors.mjs';

export function selectTools(data,{summary=false,name}={}) {
  if(data?.error)throw new ClientError('remote_error');
  const tools=data?.result?.tools;
  if(!Array.isArray(tools)||tools.some(t=>!t||typeof t.name!=='string'||!t.name)||new Set(tools.map(t=>t.name)).size!==tools.length)throw new ClientError('invalid_response');
  if(summary)return {tools:tools.map(t=>Object.fromEntries(['name','title','description','annotations'].filter(k=>Object.hasOwn(t,k)).map(k=>[k,t[k]])))};
  const tool=tools.find(t=>t.name===name);
  if(!tool)throw new ClientError('invalid_request');
  return {tool};
}
