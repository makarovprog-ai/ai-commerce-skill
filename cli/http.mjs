import https from 'node:https';
import http from 'node:http';
import {ClientError} from './errors.mjs';

export function assertEnvironment(env=process.env) {
  if ((env.NODE_TLS_REJECT_UNAUTHORIZED!==undefined && env.NODE_TLS_REJECT_UNAUTHORIZED!=='1') || env.NODE_OPTIONS) throw new ClientError('unsafe_environment');
}
export function allowedURL(value) {
  let u;try { u=new URL(value); } catch { throw new ClientError('invalid_target'); }
  if(u.origin!=='https://api.sber-ai-pay.ru'||u.hash||u.username||u.password||u.href!==value||value.length>4096||(u.pathname!=='/mcp'&&(u.search||!(/^\/sberid-auth\/(jwks|release-jwks|token|session|mcp-session|device\/requests(?:\/[A-Za-z0-9_-]{43}\/(?:prove|result))?)$/.test(u.pathname))))) throw new ClientError('invalid_target');
  return u;
}
// Import-only local synthetic test seam; no environment or command-line routing.
export async function requestJSON(value,options={},testTransport={}) {
  assertEnvironment();const canonical=allowedURL(value),headers={...options.headers};
  if(Object.keys(headers).some(k=>['cookie','x-csrf-token','host'].includes(k.toLowerCase())))throw new ClientError('invalid_request');
  const mcp=canonical.pathname==='/mcp';
  if(mcp&&(options.method!=='POST'||!Buffer.isBuffer(options.body)||options.body.length>262144))throw new ClientError('invalid_request');
  const destination=testTransport.mapURL?new URL(testTransport.mapURL(value)):canonical;
  if(destination.protocol!=='https:'&&!(testTransport.mapURL&&destination.protocol==='http:'&&destination.hostname==='127.0.0.1'))throw new ClientError('invalid_target');
  if(options.signal?.aborted)throw new ClientError('cancelled');
  return new Promise((resolve,reject)=>{
    let timer,settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const failure=()=>new ClientError(options.signal?.aborted?'cancelled':'network_error');
    const req=(destination.protocol==='https:'?https:http).request(destination,{method:options.method||'GET',headers,rejectUnauthorized:true,agent:false,signal:options.signal},res=>{
      if(res.statusCode>=300&&res.statusCode<400){finish(new ClientError('invalid_response'));res.destroy();return;}
      let size=0;const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>(mcp?4194304:65536)){finish(new ClientError('invalid_response'));req.destroy();return;}chunks.push(chunk);});
      res.on('end',()=>{try{if(!(res.headers['content-type']||'').toLowerCase().startsWith('application/json'))throw Error();finish(null,{status:res.statusCode,data:JSON.parse(Buffer.concat(chunks)),retryAfter:res.headers['retry-after']});}catch{finish(new ClientError('invalid_response'));}});
      res.on('error',()=>finish(failure()));res.on('aborted',()=>finish(failure()));
    });
    timer=setTimeout(()=>{finish(failure());req.destroy();},testTransport.timeoutMs??(mcp?180000:15000));
    req.on('error',()=>finish(failure()));req.end(options.body);
  });
}
