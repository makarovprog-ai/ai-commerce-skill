import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {Readable} from 'node:stream';
import {main} from '../cli/app.mjs';
import {CommerceClient} from '../cli/workflow.mjs';
import {requestJSON} from '../cli/http.mjs';
import {syntheticProtocol} from './fixtures/protocol.mjs';

const mcp='https://api.sber-ai-pay.ru/mcp';
const requestId='1234567890abcdef1234567890abcdef';
const marker='abc-secret-should-not-appear';
async function command(args,deps={}) {
  const results=[];
  const options=Object.defineProperties({},Object.getOwnPropertyDescriptors(deps));
  options.write=line=>results.push(JSON.parse(line));
  const code=await main(args,options);
  return {code,result:results.at(-1)};
}

test('HTML 401 during catalog discovery preserves status and correlation, and sends no search or retries', async t=>{
  const f=syntheticProtocol(); await new CommerceClient(f).login();
  const seen=[];
  const server=http.createServer((req,res)=>{
    req.resume();req.on('end',()=>{seen.push(req.method);res.writeHead(401,{'content-type':'text/html','x-request-id':requestId,'x-extra':marker});res.end(marker);});
  }).listen(0,'127.0.0.1');
  await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const transport=(url,options)=>url===mcp?requestJSON(url,options,{mapURL:()=>`http://127.0.0.1:${server.address().port}/mcp`}):f.transport(url,options);
  const {code,result}=await command(['tools','--summary'],{...f,transport});
  assert.equal(code,1);assert.equal(result.error.code,'invalid_response');
  const d=result.error.diagnostics;
  assert.equal(d.phase,'tools/list'); assert.equal(d.http_status,401);assert.equal(d.request_id,requestId);
  assert.ok(Number.isSafeInteger(d.elapsed_ms)&&d.elapsed_ms>=0);assert.ok(Number.isFinite(Date.parse(d.time_utc)));
  assert.deepEqual(seen,['POST']);assert.equal(f.blocked,false);assert.ok(!JSON.stringify(result).includes(marker));
});

test('business and preflight HTTP errors are attributed separately, without exposing arbitrary remote metadata',async()=>{
  const f=syntheticProtocol(); await new CommerceClient(f).login();
  for(const [path,phase,errorCode] of [['/mcp-session','mcp-session','invalid_response'],['/release-jwks','release-jwks','invalid_response'],['/mcp','tools/call','remote_error']]){
    let hits=0;
    const transport=(url,options)=>url.endsWith(path)?(++hits,{status:401,requestId:marker,data:{message:marker,error:'UNKNOWN_UPSTREAM'}}):f.transport(url,options);
    const {code,result}=await command(['mcp'],{...f,transport,input:Readable.from(['{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"dummy"}}'])});
    assert.equal(code,1);assert.equal(result.error.code,errorCode);assert.equal(result.error.diagnostics.phase,phase);
    assert.equal(result.error.diagnostics.http_status,401);assert.equal(hits,1);
    assert.ok(!JSON.stringify(result).includes(marker));assert.equal(f.blocked,false);
  }
});

test('refresh error preserves the durable unknown outcome and sends no duplicate refresh',async()=>{
  const f=syntheticProtocol();await new CommerceClient(f).login();f.advance(300);f.failRefresh();
  const first=await command(['tools'],f),second=await command(['tools'],f);
  assert.equal(first.result.error.reason,'refresh_outcome_unknown');assert.equal(first.result.error.diagnostics.phase,'refresh');
  assert.equal(first.result.error.diagnostics.cause,'network_error');
  assert.equal(second.result.error.reason,'refresh_outcome_unknown');assert.equal(f.refreshes,1);
  assert.equal(f.calls.some(c=>c.url===mcp),false);assert.equal(f.state.rotation_in_flight,true);
});

test('a denied login exchange preserves its request metadata without revealing redemption data',async()=>{
  const f=syntheticProtocol();let exchanges=0;
  const transport=(url,options)=>url.endsWith('/token')?(++exchanges,{status:401,requestId,data:{message:marker}}):f.transport(url,options);
  const {code,result}=await command(['login'],{...f,transport});
  assert.equal(code,1);assert.equal(result.error.code,'login_required');assert.equal(result.error.diagnostics?.phase,'token');
  assert.equal(result.error.diagnostics.http_status,401);assert.equal(result.error.diagnostics.request_id,requestId);
  assert.equal(exchanges,1);assert.equal(f.state,undefined);assert.ok(!JSON.stringify(result).includes(marker));
});

test('semantic errors in valid JSON retain their phase while HTTP 200 remains distinct from success',async()=>{
  const f=syntheticProtocol();await new CommerceClient(f).login();
  for(const [phase,path,data,code] of [
    ['mcp-session','/mcp-session',{status:'active'},'invalid_response'],
    ['tools/list','/mcp',{jsonrpc:'2.0',id:1,error:{code:-32603,message:marker}},'remote_error'],
  ]){
    const transport=(url,options)=>url.endsWith(path)?{status:200,requestId,data}:f.transport(url,options);
    const {result}=await command(['tools'],{...f,transport});
    assert.equal(result.error.code,code);assert.equal(result.error.diagnostics?.phase,phase);
    assert.equal(result.error.diagnostics.http_status,200);assert.equal(result.error.diagnostics.request_id,requestId);
    assert.ok(!JSON.stringify(result).includes(marker));
  }
});

test('a stalled error body retains the HTTP status already received',async t=>{
  const f=syntheticProtocol();await new CommerceClient(f).login();
  const server=http.createServer((req,res)=>{
    req.resume();req.once('end',()=>{res.writeHead(401,{'content-type':'text/html','x-request-id':requestId});res.write(marker);});
  }).listen(0,'127.0.0.1');
  await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const transport=(url,options)=>url===mcp?requestJSON(url,options,{mapURL:()=>`http://127.0.0.1:${server.address().port}/mcp`,timeoutMs:500}):f.transport(url,options);
  const {result}=await command(['tools'],{...f,transport});
  assert.equal(result.error.code,'network_error');assert.equal(result.error.details.stage,'response_body');
  assert.equal(result.error.diagnostics?.http_status,401);assert.equal(result.error.diagnostics.request_id,requestId);
  assert.ok(!JSON.stringify(result).includes(marker));
});

test('network doctor makes one fixed credential-free request and reports only TLS/network facts',async()=>{
  const calls=[];
  const deps={get store(){assert.fail('custody touched');},get updates(){assert.fail('updater touched');},transport:async(url,options)=>{
    calls.push({url,options});return {status:200,data:{keys:[marker]},tls:{verified:true,issuer:'Example CA',fingerprint_sha256:'AB'.repeat(32),ignored:marker}};
  }};
  const {code,result}=await command(['doctor','--network'],deps);
  assert.equal(code,0);assert.equal(result.data.network.http_status,200);assert.equal(result.data.network.tls.verified,true);
  assert.equal(result.data.network.tls.fingerprint_sha256,'AB'.repeat(32));assert.equal(result.data.runtime.node,process.versions.node);
  assert.match(result.data.runtime.cli,/^\d+\.\d+\.\d+$/);assert.ok(Number.isFinite(Date.parse(result.data.network.time_utc)));
  assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.sber-ai-pay.ru/sberid-auth/jwks');
  assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.reportPeer,true);
  assert.equal(calls[0].options.headers,undefined);assert.equal(calls[0].options.body,undefined);
  assert.ok(!JSON.stringify(result).includes(marker));
  for(const args of [['doctor','--network','--url',mcp],['doctor','--network','--profile','diagnostic'],['doctor','--network','--passphrase-fd','3'],['doctor','--network','--network'],['tools','--network']]){
    assert.equal((await command(args,deps)).result.error.code,'usage');
  }
  assert.equal(calls.length,1);
});

test('network doctor does not describe an unverified TLS result as successful', async()=>{
  const {code,result}=await command(['doctor','--network'],{transport:async()=>({status:200,tls:{verified:false,issuer:marker,fingerprint_sha256:marker}})});
  assert.equal(code,1);assert.equal(result.error.diagnostics.phase,'network-probe');assert.ok(!JSON.stringify(result).includes(marker));
});

test('network doctor omits issuer labels that look like paths',async()=>{
  const {result}=await command(['doctor','--network'],{transport:async()=>({status:200,tls:{verified:true,issuer:'/local/private/example',fingerprint_sha256:'AB'.repeat(32)}})});
  assert.equal(result.data.network.tls.issuer,undefined);assert.ok(!JSON.stringify(result).includes('/local/private/example'));
});
