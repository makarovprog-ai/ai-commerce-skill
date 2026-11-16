import https from 'node:https';
import http from 'node:http';
import {ClientError,safeRequestId} from './errors.mjs';
import {isToolListRequest,MAX_DISCOVERY_BYTES} from './tool-discovery.mjs';

function transportCause(error) {
  const code=error?.code;
  if(code==='ETIMEDOUT'||code==='ESOCKETTIMEDOUT')return 'timeout';
  if(code==='ENOTFOUND'||code==='EAI_AGAIN')return 'dns';
  if(['ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','EADDRNOTAVAIL'].includes(code))return 'connect';
  if(['ECONNRESET','ECONNABORTED','EPIPE'].includes(code))return 'reset';
  if(typeof code==='string'&&(/^(?:ERR_TLS_|ERR_SSL_)/.test(code)||['CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(code)))return 'tls';
  return 'other';
}

export function assertEnvironment(env=process.env) {
  if ((env.NODE_TLS_REJECT_UNAUTHORIZED!==undefined && env.NODE_TLS_REJECT_UNAUTHORIZED!=='1') || env.NODE_OPTIONS) throw new ClientError('unsafe_environment');
}
export function allowedURL(value) {
  let u;try { u=new URL(value); } catch { throw new ClientError('invalid_target'); }
  if(u.origin!=='https://api.sber-ai-pay.ru'||u.hash||u.username||u.password||u.href!==value||value.length>4096||(u.pathname!=='/mcp'&&(u.search||!(/^\/sberid-auth\/(jwks|release-jwks|token|session|mcp-session|device\/requests(?:\/[A-Za-z0-9_-]{43}\/(?:prove|result))?)$/.test(u.pathname))))) throw new ClientError('invalid_target');
  return u;
}
export function publicPeer(value) {
  if(value?.verified!==true)return {verified:false};
  const {issuer,fingerprint_sha256}=value;
  return {verified:true,
    ...(typeof issuer==='string'&&/^[\p{L}\p{N} .,&'()+-]{1,120}$/u.test(issuer)?{issuer}:{}),
    ...(typeof fingerprint_sha256==='string'&&/^[0-9a-f]{64}$/i.test(fingerprint_sha256)?{fingerprint_sha256:fingerprint_sha256.toUpperCase()}:{}),
  };
}
// Import-only local synthetic test seam; no environment or command-line routing.
export async function requestJSON(value,options={},testTransport={}) {
  assertEnvironment();const canonical=allowedURL(value),headers={...options.headers};
  if(Object.keys(headers).some(k=>['cookie','x-csrf-token','host'].includes(k.toLowerCase())))throw new ClientError('invalid_request');
  const mcp=canonical.pathname==='/mcp';
  if(mcp&&(options.method!=='POST'||!Buffer.isBuffer(options.body)||options.body.length>262144))throw new ClientError('invalid_request');
  if(options.reportPeer&&(canonical.pathname!=='/sberid-auth/jwks'||options.method!=='GET'||options.body!==undefined||Object.keys(headers).length))throw new ClientError('invalid_request');
  const operation=mcp?(isToolListRequest(options.body)?'mcp_metadata':'mcp_request'):'auth';
  const limit=mcp?Math.min(MAX_DISCOVERY_BYTES,options.maxResponseBytes??MAX_DISCOVERY_BYTES):65536;
  const destination=testTransport.mapURL?new URL(testTransport.mapURL(value)):canonical;
  if(destination.protocol!=='https:'&&!(testTransport.mapURL&&destination.protocol==='http:'&&destination.hostname==='127.0.0.1'))throw new ClientError('invalid_target');
  if(options.signal?.aborted)throw new ClientError('cancelled');
  return new Promise((resolve,reject)=>{
    const start=performance.now();
    let timer,settled=false,stage='request',httpMetadata;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const failure=cause=>options.signal?.aborted?new ClientError('cancelled'):new ClientError('network_error',{operation,stage,elapsed_ms:Math.floor(performance.now()-start),cause},httpMetadata);
    const req=(destination.protocol==='https:'?https:http).request(destination,{method:options.method||'GET',headers,rejectUnauthorized:true,agent:false,signal:options.signal},res=>{
      stage='response_body';
      const requestId=safeRequestId(res.headers['x-request-id']);
      httpMetadata={http_status:res.statusCode,request_id:requestId};
      const elapsed=()=>Math.floor(performance.now()-start);
      const invalid=reason=>new ClientError('invalid_response',undefined,{...httpMetadata,elapsed_ms:elapsed(),reason});
      if(res.statusCode>=300&&res.statusCode<400){finish(invalid('unexpected_redirect'));res.destroy();return;}
      let tls;
      if(options.reportPeer){
        const socket=res.socket,cert=socket.getPeerCertificate?.();
        tls=publicPeer({verified:socket.authorized,issuer:cert?.issuer?.CN,fingerprint_sha256:cert?.fingerprint256?.replaceAll(':','')});
        // The probe reports TLS and HTTP reachability, not the JWKS contents.
        finish(null,{status:res.statusCode,requestId,elapsedMs:elapsed(),tls});res.destroy();return;
      }
      let size=0;const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>limit){finish(invalid('response_too_large'));req.destroy();return;}chunks.push(chunk);});
      res.on('end',()=>{
        if(!(res.headers['content-type']||'').toLowerCase().startsWith('application/json')){finish(invalid('unexpected_content_type'));return;}
        try{finish(null,{status:res.statusCode,data:JSON.parse(Buffer.concat(chunks,size)),retryAfter:res.headers['retry-after'],responseBytes:size,requestId,elapsedMs:elapsed()});}
        catch{finish(invalid('invalid_json'));}
      });
      res.on('error',error=>finish(failure(transportCause(error))));res.on('aborted',()=>finish(failure('reset')));
    });
    timer=setTimeout(()=>{finish(failure('timeout'));req.destroy();},testTransport.timeoutMs??(operation==='mcp_request'?180000:15000));
    req.on('error',error=>finish(failure(transportCause(error))));req.end(options.body);
  });
}
