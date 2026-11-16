import {ClientError,safeRequestId} from './errors.mjs';
import {isToolListRequest,MAX_DISCOVERY_BYTES} from './tool-discovery.mjs';

// Only trusted workflow code opts in; RPC classification affects defaults, not discovery retry.
const DISCOVERY=Symbol('CLI-owned discovery');
export const discoveryAttempt=attempt=>({[DISCOVERY]:attempt});
const DISCOVERY_TIMEOUT_MS=20_000;

// Only this transport can attest that it never handed token bytes to HTTP.
// Neither error text nor a response's JSON is delivery evidence.
const unsentTokenFailures=new WeakSet();
export const tokenRequestWasNotSent=error=>unsentTokenFailures.has(error);
function unsent(error){unsentTokenFailures.add(error);return error;}

function transportCause(error) {
  const code=error?.code;
  if(code==='ETIMEDOUT'||code==='ESOCKETTIMEDOUT')return 'timeout';
  if(code==='ERR_PROXY_TUNNEL')return error.proxyTunnelTimeout?'timeout':'proxy';
  if(code==='ENOTFOUND'||code==='EAI_AGAIN')return 'dns';
  if(['ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','EADDRNOTAVAIL'].includes(code))return 'connect';
  if(['ECONNRESET','ECONNABORTED','EPIPE'].includes(code))return 'reset';
  if(typeof code==='string'&&(/^(?:ERR_TLS_|ERR_SSL_)/.test(code)||['CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(code)))return 'tls';
  return 'other';
}

export function assertEnvironment(env=process.env) {
  if ((env.NODE_TLS_REJECT_UNAUTHORIZED!==undefined && env.NODE_TLS_REJECT_UNAUTHORIZED!=='1') || env.NODE_OPTIONS) throw new ClientError('unsafe_environment');
  // Reject debug before Node networking modules load: the native global agent
  // can log proxy credentials during initialization, even without a request.
  if((env.https_proxy||env.HTTPS_PROXY)&&(env.NODE_DEBUG||env.NODE_DEBUG_NATIVE))throw new ClientError('unsafe_environment');
}
function httpsProxyAgent(Agent,env=process.env) {
  const proxy=env.https_proxy||env.HTTPS_PROXY;
  if(!proxy)return false;
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(major<24||(major===24&&minor<5))throw new ClientError('unsafe_environment');
  try{
    if(!/^https?:\/\//i.test(proxy)||/[\s\x00-\x1f\x7f]/.test(proxy))return null;
    const url=new URL(proxy);
    if(!url.hostname||url.pathname!=='/'||url.search||url.hash)return null;
    return new class extends Agent {
      // Node tracks the CONNECT socket only after origin TLS completes.
      createConnection(options,callback){this.connection=super.createConnection(options,callback);return this.connection;}
      destroy(){super.destroy();this.connection?.destroy();}
    }({keepAlive:false,rejectUnauthorized:true,
      proxyEnv:{https_proxy:url.href,no_proxy:env.no_proxy||env.NO_PROXY}});
  }catch{return null;} // Never emit the proxy URL or silently connect directly.
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
  const attempt=options[DISCOVERY];
  const tokenPost=canonical.pathname==='/sberid-auth/token'&&options.method==='POST';
  if(Object.keys(headers).some(k=>['cookie','x-csrf-token','host'].includes(k.toLowerCase())))throw new ClientError('invalid_request');
  // Node can flush an Expect request's headers before end().
  if(tokenPost&&Object.keys(headers).some(k=>k.toLowerCase()==='expect'))throw new ClientError('invalid_request');
  const mcp=canonical.pathname==='/mcp';
  if(mcp&&(options.method!=='POST'||!Buffer.isBuffer(options.body)||options.body.length>262144))throw new ClientError('invalid_request');
  if(options.reportPeer&&(canonical.pathname!=='/sberid-auth/jwks'||options.method!=='GET'||options.body!==undefined||Object.keys(headers).length))throw new ClientError('invalid_request');
  const operation=mcp?(isToolListRequest(options.body)?'mcp_metadata':'mcp_request'):'auth';
  const limit=mcp?Math.min(MAX_DISCOVERY_BYTES,options.maxResponseBytes??MAX_DISCOVERY_BYTES):65536;
  const destination=testTransport.mapURL?new URL(testTransport.mapURL(value)):canonical;
  if(destination.protocol!=='https:'&&!(testTransport.mapURL&&destination.protocol==='http:'&&destination.hostname==='127.0.0.1'))throw new ClientError('invalid_target');
  const secure=destination.protocol==='https:';
  const start=performance.now();
  const elapsed=()=>Math.floor(performance.now()-start);
  const attemptMetadata=attempt===undefined?undefined:{attempt};
  let stage='request',httpMetadata,requestStarted=false;
  const failure=cause=>{
    const notSent=tokenPost&&!requestStarted&&stage==='request';
    const error=options.signal?.aborted?new ClientError('cancelled'):new ClientError('network_error',{
      operation,stage,elapsed_ms:elapsed(),cause,...(notSent?{delivery:'not_sent'}:{})
    },attemptMetadata?{...attemptMetadata,...httpMetadata}:httpMetadata);
    return notSent?unsent(error):error;
  };
  if(options.signal?.aborted)throw failure('other');
  let transport;
  try{transport=secure?await import('node:https'):await import('node:http');}
  catch(error){throw failure(error?.code==='ERR_PROXY_INVALID_CONFIG'||(secure&&(process.env.https_proxy||process.env.HTTPS_PROXY))?'proxy':'other');}
  if(options.signal?.aborted)throw failure('other');
  const timeout=testTransport.timeoutMs??(attemptMetadata?DISCOVERY_TIMEOUT_MS:operation==='mcp_request'?180000:15000);
  return new Promise((resolve,reject)=>{
    let timer,agent,onAbort,settled=false;
    const finish=(error,value)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      if(onAbort)options.signal.removeEventListener('abort',onAbort);
      if(agent)agent.destroy();
      error?reject(error):resolve(value);
    };
    try{agent=secure?httpsProxyAgent(transport.Agent):false;}
    catch(error){finish(tokenPost?unsent(error):error);return;}
    if(agent===null){finish(failure('proxy'));return;}
    const req=transport.default.request(destination,{method:options.method||'GET',headers,rejectUnauthorized:true,agent,...(agent?{timeout}:{signal:options.signal})},res=>{
      stage='response_body';
      const requestId=safeRequestId(res.headers['x-request-id']);
      const ttfbMs=attemptMetadata?(httpMetadata?.ttfb_ms??elapsed()):undefined;
      httpMetadata={http_status:res.statusCode,request_id:requestId,...(attemptMetadata?{attempt,ttfb_ms:ttfbMs}:{})};
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
        try{finish(null,{status:res.statusCode,data:JSON.parse(Buffer.concat(chunks,size)),retryAfter:res.headers['retry-after'],responseBytes:size,requestId,elapsedMs:elapsed(),
          ...(attemptMetadata?{attempt,ttfbMs}:{})});}
        catch{finish(invalid('invalid_json'));}
      });
      res.on('error',error=>finish(failure(transportCause(error))));res.on('aborted',()=>finish(failure('reset')));
    });
    timer=setTimeout(()=>{finish(failure('timeout'));req.destroy();},timeout);
    req.on('error',error=>finish(failure(transportCause(error))));
    if(attemptMetadata){
      // Even interim response headers make a loss ineligible for resend.
      req.on('information',info=>{httpMetadata??={http_status:info.statusCode,ttfb_ms:elapsed()};});
      // Node dispatches 101 separately from ordinary HTTP responses.
      req.on('upgrade',(res,socket)=>{
        finish(new ClientError('invalid_response',undefined,{attempt,http_status:res.statusCode,
          request_id:res.headers['x-request-id'],ttfb_ms:httpMetadata?.ttfb_ms??elapsed(),
          elapsed_ms:elapsed(),reason:'unexpected_http_status'}));
        socket.destroy();
      });
    }
    // ClientRequest's abort handling cannot close a pending proxy connection.
    if(agent&&options.signal){
      onAbort=()=>{finish(failure('other'));req.destroy();};
      options.signal.addEventListener('abort',onAbort,{once:true});
      if(options.signal.aborted){onAbort();return;}
    }
    if(tokenPost){
      // Do not queue token headers or body in Node/TLS while connecting.
      // From the first call to end(), even a reset without headers is ambiguous.
      const send=()=>{
        if(settled||req.destroyed||requestStarted)return;
        requestStarted=true;
        try{req.end(options.body);}
        catch(error){finish(failure(transportCause(error)));req.destroy();}
      };
      req.on('socket',socket=>{
        if(destination.protocol==='https:'){
          if(socket.authorized)send();
          else socket.once('secureConnect',()=>{if(socket.authorized)send();});
        }else if(socket.connecting)socket.once('connect',send);
        else send();
      });
    }else req.end(options.body);
  });
}
