import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {EventEmitter,once} from 'node:events';
import {requestJSON,allowedURL,assertEnvironment} from '../cli/http.mjs';
import {main} from '../cli/app.mjs';
import {publicError} from '../cli/errors.mjs';
import {CommerceClient} from '../cli/workflow.mjs';
import {syntheticProtocol} from './fixtures/protocol.mjs';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';

test('a stalled TLS handshake never sends refresh; the original session stays usable without login',async t=>{
 const server=net.createServer(socket=>{sockets.add(socket);socket.on('data',()=>{});socket.on('close',()=>sockets.delete(socket));});
 const sockets=new Set();
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));});
 const f=syntheticProtocol();await new CommerceClient(f).login();f.advance(301);
 const before=structuredClone(f.state), values=[];
 let tokenAttempts=0;
 const transport=(url,options)=>{
  if(url.endsWith('/token')&&++tokenAttempts===1)return requestJSON(url,options,{mapURL:()=>`https://127.0.0.1:${server.address().port}/token`,timeoutMs:250});
  return f.transport(url,options);
 };
 const deps={...f,transport,write:v=>values.push(JSON.parse(v)),updates:{check:async()=>({status:'unavailable'})}};
 assert.equal(await main(['tools'],deps),1);
 assert.equal(values[0].error.code,'network_error');
 assert.equal(values[0].error.next_action,undefined);
 assert.equal(values[0].error.details.delivery,'not_sent');
 assert.equal(values[0].error.details.cause,'timeout');
 assert.equal(values[0].error.diagnostics.phase,'refresh');
 assert.deepEqual(f.state,before);
 assert.equal(tokenAttempts,1);
 assert.equal(await main(['tools'],deps),0);
 assert.equal(f.refreshes,1);
 assert.equal(tokenAttempts,2);
});

test('refresh on a connected socket with no reply remains ambiguous even before response headers',async t=>{
 let handled=0;
 const server=http.createServer((req,res)=>{req.resume();req.on('end',()=>{handled++;res.destroy();});});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const f=syntheticProtocol();await new CommerceClient(f).login();f.advance(301);
 const transport=(url,options)=>url.endsWith('/token')?requestJSON(url,options,{mapURL:()=>`http://127.0.0.1:${server.address().port}/token`}):f.transport(url,options);
 const client=new CommerceClient({...f,transport});
 await assert.rejects(client.tools(),{code:'login_required',reason:'refresh_outcome_unknown'});
 assert.equal(f.state.rotation_in_flight,true);
 await assert.rejects(client.tools(),{code:'login_required',reason:'refresh_outcome_unknown'});
 assert.equal(handled,1);
});

test('token requests reject Expect headers that could flush before the send gate',async t=>{
 let connects=0;
 const server=net.createServer(socket=>{connects++;socket.destroy();});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 await assert.rejects(requestJSON('https://api.sber-ai-pay.ru/sberid-auth/token',
  {method:'POST',headers:{Expect:'100-continue'},body:'synthetic'},
  {mapURL:()=>`http://127.0.0.1:${server.address().port}/token`,timeoutMs:250}),{code:'invalid_request'});
 assert.equal(connects,0);
});
test('targets and environment never enable arbitrary hosts or unsafe TLS',()=>{
 for(const url of ['http://api.sber-ai-pay.ru/mcp','https://wrong.test/mcp','https://api.sber-ai-pay.ru/sberid-auth/token?x=1','https://api.sber-ai-pay.ru/mcp#x'])assert.throws(()=>allowedURL(url));
 assert.equal(allowedURL('https://api.sber-ai-pay.ru/mcp?x=1').search,'?x=1');
 assert.throws(()=>assertEnvironment({NODE_TLS_REJECT_UNAUTHORIZED:'0'}));assert.throws(()=>assertEnvironment({NODE_OPTIONS:'--import secret'}));assert.doesNotThrow(()=>assertEnvironment({}));
});
test('transport enforces exact bytes, no redirects, finite body deadline, cancellation and response caps',async()=>{
 const server=http.createServer((req,res)=>{let bytes=[];req.on('data',c=>bytes.push(c));req.on('end',()=>{
  if(req.url==='/stall'){res.writeHead(200,{'content-type':'application/json'});res.write('{');return;}
  if(req.url==='/redirect'){res.writeHead(302,{location:'https://wrong.test'});res.end();return;}
  if(req.url==='/large'){res.writeHead(200,{'content-type':'application/json'});res.end('"'+'a'.repeat(70000)+'"');return;}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({hex:Buffer.concat(bytes).toString('hex')}));
 });});server.listen(0,'127.0.0.1');await once(server,'listening');
 const local=`http://127.0.0.1:${server.address().port}`;const transport=(path,timeoutMs=2000)=>({mapURL:()=>local+path,timeoutMs});
 try{
  const body=Buffer.from(' {"x":1}\r\n');const r=await requestJSON('https://api.sber-ai-pay.ru/mcp',{method:'POST',body},transport('/ok'));assert.equal(r.data.hex,'207b2278223a317d0d0a');
  await assert.rejects(requestJSON('https://api.sber-ai-pay.ru/sberid-auth/jwks',{},transport('/redirect')),{code:'invalid_response'});
  await assert.rejects(requestJSON('https://api.sber-ai-pay.ru/sberid-auth/jwks',{},transport('/large')),{code:'invalid_response'});
  await assert.rejects(requestJSON('https://api.sber-ai-pay.ru/sberid-auth/jwks',{},transport('/stall',60)),{code:'network_error'});
  const abort=new AbortController();const pending=requestJSON('https://api.sber-ai-pay.ru/sberid-auth/jwks',{signal:abort.signal},transport('/stall'));abort.abort();await assert.rejects(pending,{code:'cancelled'});
  for(const headers of [{Cookie:'a'},{Host:'x'},{'X-CSRF-Token':'a'}])await assert.rejects(requestJSON('https://api.sber-ai-pay.ru/sberid-auth/jwks',{headers}),{code:'invalid_request'});
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('only valid tools/list metadata and Auth get the 15 second total body deadline',async t=>{
 const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('{');});server.listen(0,'127.0.0.1');await once(server,'listening');
 const delays=[],schedule=globalThis.setTimeout;
 t.mock.method(globalThis,'setTimeout',(callback,delay,...args)=>{delays.push(delay);return schedule(callback,75,...args);});
 const seam={mapURL:()=>`http://127.0.0.1:${server.address().port}/stall`};
 try{
  const expired=operation=>error=>{
   const result=publicError(error);
   const stage=result.details?.stage;
   assert.ok(['request','response_body'].includes(stage));
   assert.deepEqual(result,{code:'network_error',details:{operation,stage,elapsed_ms:result.details?.elapsed_ms,cause:'timeout'},...(stage==='response_body'?{diagnostics:{http_status:200}}:{})});
   assert.ok(Number.isSafeInteger(result.details.elapsed_ms)&&result.details.elapsed_ms>=0);
   return true;
  };
  await assert.rejects(requestJSON('https://api.sber-ai-pay.ru/sberid-auth/jwks',{},seam),expired('auth'));
  const target='https://api.sber-ai-pay.ru/mcp';
  const list={jsonrpc:'2.0',id:2,method:'tools/list',params:{cursor:'next'}};
  for(const [payload,operation] of [
   [list,'mcp_metadata'],
   [{...list,params:undefined},'mcp_metadata'],
   [{...list,id:undefined},'mcp_request'],
   [{...list,jsonrpc:'1.0'},'mcp_request'],
   [{...list,params:{cursor:47}},'mcp_request'],
   [{...list,method:'tools/call',params:{name:'tools/list',arguments:{cursor:'next'}}},'mcp_request'],
   [[list],'mcp_request'],
  ])await assert.rejects(requestJSON(target,{method:'POST',body:Buffer.from(JSON.stringify(payload))},seam),expired(operation));
  assert.deepEqual(delays,[15000,15000,15000,180000,180000,180000,180000,180000]);
 }finally{t.mock.restoreAll();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('business timeout diagnostics never imply non-execution or replay the original signed bytes',async t=>{
 const f=syntheticProtocol();await new CommerceClient(f).login();
 const target='https://api.sber-ai-pay.ru/mcp';
 const secret='synthetic-secret-for-request';
 const body=Buffer.from(` {"id":"a","jsonrpc":"2.0","method":"tools/call","params":{"name":"dynamic_mutation","arguments":{"value":"${secret}"}}}\r\n`);
 const attempts=[],values=[];
 const server=http.createServer((req,res)=>{
  const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
   attempts.push({body:Buffer.concat(chunks),digest:req.headers['content-digest'],signature:req.headers.signature});
   res.writeHead(200,{'content-type':'application/json'});res.write(secret);
  });
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const transport=(url,options)=>url===target?requestJSON(url,options,{mapURL:()=>`http://127.0.0.1:${server.address().port}/?${secret}`,timeoutMs:150}):f.transport(url,options);
 assert.equal(await main(['mcp'],{...f,transport,input:Readable.from([body]),write:v=>values.push(JSON.parse(v))}),1);
 assert.equal(attempts.length,1);assert.deepEqual(attempts[0].body,body);assert.ok(attempts[0].signature);
 assert.equal(attempts[0].digest,`sha-256=:${createHash('sha256').update(body).digest('base64')}:`);
 const output=values.at(-1);
 assert.deepEqual(output,{version:1,ok:false,error:{code:'network_error',details:{operation:'mcp_request',stage:'response_body',elapsed_ms:output.error.details?.elapsed_ms,cause:'timeout'},diagnostics:{phase:'tools/call',http_status:200,time_utc:output.error.diagnostics.time_utc,elapsed_ms:output.error.details.elapsed_ms}}});
 assert.ok(output.error.details.elapsed_ms>=0);
 assert.ok(!JSON.stringify(output).includes(secret));
});

test('transport cause mapping never copies error messages, paths, or unrecognized codes',async t=>{
 const secret='must-not-leak.example/secret-path',emitted=[];
 for(const [code,cause] of [['ENOTFOUND','dns'],['EAI_AGAIN','dns'],['ECONNREFUSED','connect'],['CERT_HAS_EXPIRED','tls'],['ECONNRESET','reset'],[secret,'other']]){
  t.mock.method(http,'request',()=>{
   const req=new EventEmitter();
   req.end=()=>queueMicrotask(()=>req.emit('error',Object.assign(new Error(secret),{code,path:secret})));
   req.destroy=()=>{};
   return req;
  });
  try{
   await assert.rejects(requestJSON('https://api.sber-ai-pay.ru/mcp?synthetic-secret',{method:'POST',body:Buffer.from('{}')},{mapURL:()=>`http://127.0.0.1/?${secret}`}),error=>{
    const output=publicError(error);emitted.push(output);
    assert.deepEqual(output,{code:'network_error',details:{operation:'mcp_request',stage:'request',elapsed_ms:output.details?.elapsed_ms,cause}});
    assert.ok(output.details.elapsed_ms>=0);return true;
   });
  }finally{t.mock.restoreAll();}
 }
 assert.ok(!JSON.stringify(emitted).includes(secret));
});
