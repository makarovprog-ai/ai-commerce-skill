import {ClientError,httpError} from './errors.mjs';

export const MAX_DISCOVERY_BYTES=4*1024*1024;
const MAX_PAGES=20;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const rpcId=value=>typeof value==='string'||Number.isFinite(value);
const cursor=value=>typeof value==='string'&&value.length>0;
const invalidResponse=()=>new ClientError('invalid_response');
const metadataBody=(id,next)=>Buffer.from(JSON.stringify({jsonrpc:'2.0',id,method:'tools/list',params:next===undefined?{}:{cursor:next}}));

// For transport budgeting only, never authorization or rewriting request bytes.
export function isToolListRequest(body) {
  let request;try{request=JSON.parse(body);}catch{return false;}
  if(!object(request)||request.jsonrpc!=='2.0'||!rpcId(request.id)||request.method!=='tools/list'||Object.hasOwn(request,'result')||Object.hasOwn(request,'error'))return false;
  if(!Object.hasOwn(request,'params'))return true;
  const {params}=request;
  return object(params)&&(!Object.hasOwn(params,'cursor')||cursor(params.cursor))&&(!Object.hasOwn(params,'_meta')||object(params._meta));
}
export function mcpPhase(body) {
  if(isToolListRequest(body))return 'tools/list';
  try {const r=JSON.parse(body);if(object(r)&&r.jsonrpc==='2.0'&&rpcId(r.id)&&r.method==='tools/call'&&object(r.params)&&typeof r.params.name==='string')return 'tools/call';}catch{}
  return 'mcp';
}

function pageTools(data,id,names=new Set()) {
  if(!object(data)||data.jsonrpc!=='2.0'||!rpcId(data.id)||(id!==undefined&&data.id!==id))throw invalidResponse();
  if(Object.hasOwn(data,'error')){
    if(Object.hasOwn(data,'result')||!object(data.error)||!Number.isInteger(data.error.code)||typeof data.error.message!=='string')throw invalidResponse();
    throw new ClientError('remote_error');
  }
  const result=data.result;
  if(!object(result)||!Array.isArray(result.tools)||(Object.hasOwn(result,'nextCursor')&&!cursor(result.nextCursor)))throw invalidResponse();
  for(const tool of result.tools){
    if(!object(tool)||typeof tool.name!=='string'||!tool.name||!object(tool.inputSchema)||(Object.hasOwn(tool,'outputSchema')&&!object(tool.outputSchema))||names.has(tool.name))throw invalidResponse();
    names.add(tool.name);
  }
  return result;
}

export function validateCompleteTools(data) {
  const result=pageTools(data);
  if(Object.hasOwn(result,'nextCursor'))throw invalidResponse();
  return data;
}

export function readToolSnapshot(bytes) {
  try{
    const envelope=JSON.parse(bytes);
    if(!object(envelope)||envelope.version!==1||envelope.ok!==true||Object.hasOwn(envelope,'error')||Object.hasOwn(envelope,'event'))throw invalidResponse();
    return validateCompleteTools(envelope.data);
  }catch{throw new ClientError('invalid_request');}
}

export async function discoverTools(send) {
  let first,next,remaining=MAX_DISCOVERY_BYTES;
  const tools=[],names=new Set(),cursors=new Set();
  for(let id=1;id<=MAX_PAGES;id++){
    const body=metadataBody(id,next);
    if(body.length>262144)throw invalidResponse();
    const response=await send(body,remaining);
    if(response.status<200||response.status>=300)throw httpError('remote_error',response,'tools/list');
    let result;try{result=pageTools(response.data,id,names);}catch(error){
      if(error instanceof ClientError)throw httpError(error.code,response,'tools/list');
      throw error;
    }
    let size;try{size=response.responseBytes??Buffer.byteLength(JSON.stringify(response.data));}catch{throw invalidResponse();}
    if(!Number.isSafeInteger(size)||size<1||size>remaining)throw invalidResponse();
    remaining-=size;
    if(id===1){
      if(result.nextCursor===undefined)return response;
      first=response;
    }
    for(const tool of result.tools)tools.push(tool);
    next=result.nextCursor;
    if(next===undefined){
      const {nextCursor:_,...extra}=first.data.result;
      return {...first,data:{...first.data,result:{...extra,tools}}};
    }
    if(!remaining||cursors.has(next))throw invalidResponse();
    cursors.add(next);
  }
  throw invalidResponse();
}

export function selectTools(data,{summary=false,name}={}) {
  if(!summary&&name===undefined)return data;
  const {tools}=data.result;
  if(summary)return {tools:tools.map(t=>Object.fromEntries(['name','title','description','annotations'].filter(k=>Object.hasOwn(t,k)).map(k=>[k,t[k]])))};
  const tool=tools.find(t=>t.name===name);
  if(!tool)throw new ClientError('invalid_request');
  return {tool};
}
