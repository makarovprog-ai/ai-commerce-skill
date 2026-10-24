import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {requestJSON,allowedURL,assertEnvironment} from '../cli/http.mjs';
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
test('default auth and MCP deadlines cover the entire body at 15 and 180 seconds',async t=>{
 const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('{');});server.listen(0,'127.0.0.1');await once(server,'listening');
 const delays=[],schedule=globalThis.setTimeout;
 t.mock.method(globalThis,'setTimeout',(callback,delay,...args)=>{delays.push(delay);return schedule(callback,15,...args);});
 const seam={mapURL:()=>`http://127.0.0.1:${server.address().port}/stall`};
 try{
  await assert.rejects(requestJSON('https://api.sber-ai-pay.ru/sberid-auth/jwks',{},seam),{code:'network_error'});
  await assert.rejects(requestJSON('https://api.sber-ai-pay.ru/mcp',{method:'POST',body:Buffer.from('{}')},seam),{code:'network_error'});
  assert.deepEqual(delays,[15000,180000]);
 }finally{t.mock.restoreAll();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
