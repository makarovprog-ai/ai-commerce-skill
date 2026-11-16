import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {CommerceClient} from '../cli/workflow.mjs';
import {requestJSON} from '../cli/http.mjs';
import {ClientError,publicError} from '../cli/errors.mjs';
import {syntheticProtocol} from './fixtures/protocol.mjs';

const route=url=>new URL(url).pathname.split('/').at(-1);
const rpc=id=>({jsonrpc:'2.0',id,method:'tools/list',params:{}});
const page=(id,nextCursor)=>({jsonrpc:'2.0',id,result:{tools:[{name:`tool-${id}`,inputSchema:{type:'object'}}],...(nextCursor?{nextCursor}:{})}});
const jwtJti=proof=>JSON.parse(Buffer.from(proof.split('.')[1],'base64url')).jti;
const network=(cause='timeout',stage='request',diagnostics)=>new ClientError('network_error',{operation:'auth',stage,elapsed_ms:20,cause},diagnostics);

async function fixture(){
 const f=syntheticProtocol();await new CommerceClient(f).login();
 const attempts=[],sleeps=[];
 const client=({handle,signal,sleep}={})=>new CommerceClient({...f,signal,sleep:async(ms,value,options)=>{
  assert.ok(ms>=200&&ms<=500);assert.equal(options.signal,signal);sleeps.push(ms);await sleep?.(ms,value,options);
 },transport:async(url,options)=>{
  const path=route(url),attempt={path,url,options};attempts.push(attempt);
  const valid=await f.transport(url,options);
  return handle?handle(attempt,valid):valid;
 }});
 return {f,attempts,sleeps,client};
}

async function loopback(t,handle){
 const server=http.createServer((req,res)=>{
  const chunks=[];req.on('data',b=>chunks.push(b));req.on('end',()=>handle(req,res,Buffer.concat(chunks)));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 return (url,options,testOptions)=>requestJSON(url,options,{
  mapURL:()=>`http://127.0.0.1:${server.address().port}/${route(url)}`,...testOptions
 });
}

test('tools retries the current page after a valid response is lost, with identical bytes and a new signed envelope',async t=>{
 const {f,attempts,sleeps,client}=await fixture();const wire=[];
 const local=await loopback(t,(req,res,body)=>{
  wire.push({headers:req.headers,body});const {id}=JSON.parse(body);
  const payload=page(id,id===1?'opaque+/= cursor':undefined);
  if(wire.length===2){res.destroy();return;} // The server processed page two; the response never reached the client.
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(payload));
 });
 const result=await client({handle:({path,url,options},response)=>path==='mcp'?local(url,options):response}).tools();
 assert.deepEqual(result.data.result.tools.map(tool=>tool.name),['tool-1','tool-2']);
 assert.deepEqual(attempts.map(a=>a.path),['mcp-session','release-jwks','mcp','mcp','mcp']);
 const [,first,second]=wire;
 assert.deepEqual(JSON.parse(first.body),{...rpc(2),params:{cursor:'opaque+/= cursor'}});
 assert.deepEqual(first.body,second.body);
 assert.notEqual(jwtJti(first.headers.dpop),jwtJti(second.headers.dpop));
 assert.notEqual(first.headers['aipay-key-release'],second.headers['aipay-key-release']);
 assert.notEqual(first.headers['ai-commerce-signature'],second.headers['ai-commerce-signature']);
 assert.equal(first.headers['content-digest'],second.headers['content-digest']);
 assert.equal(sleeps.length,1);assert.equal(f.refreshes,0);
});

test('direct session retries both prep GETs when needed, but one GET can spend the entire command budget',async()=>{
 const {attempts,sleeps,client}=await fixture();
 for(const failedPath of ['mcp-session','release-jwks']){
  attempts.length=0;sleeps.length=0;let failed=false;
  const response=await client({handle:({path},valid)=>{
   if(path===failedPath&&!failed){failed=true;throw network();}
   return valid;
  }}).session();
  assert.equal(response.provider_check,'verified');
  const calls=attempts.filter(a=>a.path===failedPath);
  assert.equal(calls.length,2);assert.equal(sleeps.length,1);
  if(failedPath==='mcp-session')assert.notEqual(jwtJti(calls[0].options.headers.DPoP),jwtJti(calls[1].options.headers.DPoP));
 }
 attempts.length=0;sleeps.length=0;
 let gets=0;
 await assert.rejects(client({handle:({path},valid)=>{
  if((path==='mcp-session'&&++gets===1)||path==='mcp')throw network('reset');
  return valid;
 }}).session(),error=>publicError(error).code==='network_error'&&publicError(error).next_action===undefined);
 assert.deepEqual(attempts.map(a=>a.path),['mcp-session','mcp-session','release-jwks','mcp']);
 assert.equal(sleeps.length,1);
});

test('discovery cancellation or access expiry during backoff prevents a resend or rotation',async()=>{
 const {f,attempts,sleeps,client}=await fixture();
 const abort=new AbortController();
 const handle=({path},valid)=>{if(path==='mcp-session')throw network();return valid;};
 await assert.rejects(client({signal:abort.signal,sleep:()=>abort.abort(),handle}).tools(),{code:'cancelled'});
 assert.deepEqual(attempts.map(a=>a.path),['mcp-session']);assert.equal(sleeps.length,1);
 attempts.length=0;sleeps.length=0;
 await assert.rejects(client({sleep:()=>f.advance(301),handle}).tools(),{code:'network_error'});
 assert.deepEqual(attempts.map(a=>a.path),['mcp-session']);assert.equal(sleeps.length,1);assert.equal(f.refreshes,0);
});

test('generic caller-owned tools/list, business RPCs and explicit refresh do not gain discovery retries',async()=>{
 const {attempts,sleeps,client}=await fixture();
 for(const [invoke,path] of [
  [c=>c.mcp(Buffer.from(JSON.stringify(rpc(1)))),'mcp'],
  [c=>c.mcp(Buffer.from(JSON.stringify({...rpc(1),method:'tools/call',params:{name:'create_checkout'}}))),'mcp'],
  [c=>c.refresh(),'mcp-session'],[c=>c.refresh(),'release-jwks'],[c=>c.refresh(),'mcp'],
  [c=>c.tools(), 'token'],[c=>c.tools(),'jwks'],
 ]){
  attempts.length=0;
  const c=client({handle:({path:p},valid)=>{if(p===path)throw network();return valid;}});
  if(path==='token'||path==='jwks'){
   // Each failed rotation intentionally leaves its token in flight. Use fresh custody.
   const isolated=await fixture();isolated.f.advance(250);
   await assert.rejects(invoke(isolated.client({handle:({path:p},valid)=>{if(p===path)throw network();return valid;}})),{code:'login_required',reason:'refresh_outcome_unknown'});
   assert.equal(isolated.attempts.filter(a=>a.path===path).length,1);
   assert.equal(isolated.sleeps.length,0);
  }else{
   await assert.rejects(invoke(c),{code:'network_error'});
   assert.equal(attempts.filter(a=>a.path===path).length,1);
  }
 }
 assert.equal(sleeps.length,0);
});

test('discovery never retries network policy failures or failures after any HTTP status is available',async()=>{
 const {attempts,sleeps,client}=await fixture();
 for(const error of [network('tls'),network('proxy'),network('dns'),network('reset','response_body'),
  network('reset','request',{http_status:503}),Object.assign(new Error('timeout'),{code:'network_error',details:{stage:'request',cause:'timeout'}})]){
  attempts.length=0;
  await assert.rejects(client({handle:()=>{throw error;}}).tools());
  assert.deepEqual(attempts.map(a=>a.path),['mcp-session']);
 }
 assert.equal(sleeps.length,0);
});

test('discovery uses 20 seconds for the complete response and emits sanitized attempt and header timing on terminal failures',async t=>{
 const {attempts,sleeps,client}=await fixture();
 let behavior='stall';
 const prep=new Map();
 const local=await loopback(t,(req,res)=>{
  if(prep.has(req.url)){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(prep.get(req.url)));return;}
  if(behavior==='drop'){res.destroy();return;}
  if(behavior==='unanswered')return;
  if(behavior==='information'){res.writeEarlyHints({link:'</synthetic>; rel=preload'});res.socket.end();return;}
  if(behavior==='upgrade'){res.writeHead(101,{connection:'upgrade',upgrade:'synthetic'});res.end();return;}
  res.writeHead(behavior==='http'?500:200,{'content-type':'application/json'});
  if(behavior==='stall'){res.write('{');return;}
  res.end(behavior==='invalid'?'not-json':JSON.stringify({synthetic:'response'}));
 });
 const delays=[],schedule=globalThis.setTimeout;
 t.mock.method(globalThis,'setTimeout',(callback,delay,...args)=>{delays.push(delay);return schedule(callback,100,...args);});
 const run=()=>client({handle:({path,url,options},valid)=>{
  if(path!=='mcp')prep.set('/'+path,valid.data);
  return local(url,options);
 }}).tools();
 for(const [mode,code,status,attempt] of [['stall','network_error',200,1],['http','remote_error',500,1],['invalid','invalid_response',200,1],
  ['drop','network_error',undefined,2],['unanswered','network_error',undefined,2],['information','network_error',103,1],['upgrade','invalid_response',101,1]]){
  behavior=mode;attempts.length=0;sleeps.length=0;delays.length=0;
  await assert.rejects(run(),error=>{
   const output=publicError(error);
   assert.equal(output.code,code);assert.equal(output.next_action,undefined);
   assert.equal(output.diagnostics?.attempt,attempt);assert.equal(output.diagnostics?.http_status,status);
   if(status===undefined){
    assert.equal(output.diagnostics?.ttfb_ms,undefined);assert.ok(output.details.elapsed_ms>=0);
   }else assert.ok(Number.isSafeInteger(output.diagnostics?.ttfb_ms)&&output.diagnostics.ttfb_ms>=0);
   assert.doesNotMatch(JSON.stringify(output),/api\.sber|proof|synthetic|not-json/);
   return true;
  });
  assert.equal(attempts.filter(a=>a.path==='mcp').length,attempt);
  assert.deepEqual(delays,Array(attempt+2).fill(20000));
  assert.equal(sleeps.length,attempt-1);
 }
});
