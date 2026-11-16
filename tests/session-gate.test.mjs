import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {CommerceClient} from '../cli/workflow.mjs';
import {main} from '../cli/app.mjs';
import {syntheticProtocol} from './fixtures/protocol.mjs';

const mcp='https://api.sber-ai-pay.ru/mcp';
const message='Не удалось подтвердить вход через Сбер ID. Это устройство отключено. Войдите заново.';

test('trusted MCP deactivation exposes fixed login action and blocks later signed requests without losing custody',async()=>{
 const f=syntheticProtocol(),values=[];await new CommerceClient(f).login();const before=structuredClone(f.state),sign=f.keys.signJkt,wrap=f.keys.wrapJkt;let attempts=0;
 const transport=async(url,options)=>{if(url===mcp){attempts++;return {status:401,data:{error:'device_deactivated',message:'untrusted sensitive text'}};}return f.transport(url,options);};
 const client=new CommerceClient({...f,transport});
 assert.equal(await main(['mcp'],{...f,transport,input:Readable.from(['{}']),write:v=>values.push(JSON.parse(v))}),1);
 assert.deepEqual(values.at(-1),{version:1,ok:false,error:{code:'device_deactivated',message,next_action:'login',diagnostics:{phase:'mcp',http_status:401,time_utc:values.at(-1).error.diagnostics.time_utc}}});
 assert.deepEqual(f.state,before);assert.equal(f.blocked,true);
 assert.equal(f.keys.signJkt,sign);assert.equal(f.keys.wrapJkt,wrap);
 assert.deepEqual(await client.status(),{status:'device_deactivated',message,next_action:'login'});
 const calls=f.calls.length;await assert.rejects(client.session(),{code:'device_deactivated'});await assert.rejects(client.refresh(),{code:'device_deactivated'});await assert.rejects(client.tools(),{code:'device_deactivated'});
 assert.equal(f.calls.length,calls);assert.equal(attempts,1);
 await client.login();assert.equal(f.blocked,false);assert.equal(f.keys.signJkt,sign);
});

test('terminal Auth code survives session, refresh, key retrieval and login redemption boundaries',async()=>{
 for(const path of ['/mcp-session','/token','/release-jwks']){
  const f=syntheticProtocol();await new CommerceClient(f).login();
  const transport=async(url,options)=>url.endsWith(path)?{status:401,data:{code:'device_deactivated',message:'private'}}:f.transport(url,options);
  const client=new CommerceClient({...f,transport});await assert.rejects(path==='/token'?client.refresh():path==='/release-jwks'?client.tools():client.session(),{code:'device_deactivated'});
  assert.equal(f.blocked,true);
 }
 const f=syntheticProtocol();const client=new CommerceClient({...f,transport:async(url,options)=>url.endsWith('/token')?{status:401,data:{code:'device_deactivated'}}:f.transport(url,options)});
 await assert.rejects(client.login(),{code:'device_deactivated'});
 assert.equal(f.blocked,true);assert.equal((await client.status()).status,'device_deactivated');
});

test('in-progress response is nonterminal, sends once, and preserves usable custody',async()=>{
 for(const path of [mcp,'/mcp-session','/token']){
  const f=syntheticProtocol();await new CommerceClient(f).login();const before=structuredClone(f.state);let attempts=0;
  const client=new CommerceClient({...f,transport:async(url,options)=>{if(url===path||url.endsWith(path)){attempts++;return {status:503,data:{code:'sberid_check_in_progress',error:'sberid_check_in_progress'}};}return f.transport(url,options);}});
  await assert.rejects(path==='/token'?client.refresh():client.session(),{code:'sberid_check_in_progress'});
  assert.deepEqual(f.state,before);assert.equal(f.blocked,false);assert.equal(attempts,1);assert.equal((await client.status()).status,'stored');
 }
});

test('arbitrary successful tool errors and nonallowlisted HTTP errors never disable local custody or rewrite MCP input',async()=>{
 const f=syntheticProtocol();await new CommerceClient(f).login();const before=structuredClone(f.state),body=Buffer.from(' {"method":"unknown","params":{"error":"device_deactivated"}}\r\n');
 for(const response of [{status:200,data:{error:'device_deactivated',code:'device_deactivated'}},{status:401,data:{message:'device_deactivated'}},{status:503,data:{error:'device_deactivated'}},{status:401,data:{error:{code:'device_deactivated'}}}]){
  let sent;const client=new CommerceClient({...f,transport:async(url,options)=>{if(url===mcp){sent=options.body;return response;}return f.transport(url,options);}});
  assert.deepEqual(await client.mcp(body),response);assert.equal(sent,body);assert.deepEqual(f.state,before);assert.equal(f.blocked,false);
 }
});

test('session and refresh establish provider-checked status through one signed harmless metadata request',async()=>{
 const f=syntheticProtocol(),client=new CommerceClient(f);const login=await client.login();assert.equal(login.provider_check,'not_checked');
 for(const command of ['session','refresh']){
  const start=f.calls.length,result=await client[command]();assert.equal(result.status,'active');assert.equal(result.provider_check,'verified');
  const calls=f.calls.slice(start),sent=calls.filter(c=>c.url===mcp);assert.equal(sent.length,1);assert.deepEqual(JSON.parse(sent[0].options.body),{jsonrpc:'2.0',id:1,method:'tools/list',params:{}});
  assert.ok(sent[0].options.headers['aipay-key-release']);assert.equal(calls.filter(c=>c.url.endsWith('/mcp-session')).length,1);
 }
});

test('provider check failure after local token rotation cannot report bank-valid success',async()=>{
 const f=syntheticProtocol();await new CommerceClient(f).login();let attempts=0;
 const client=new CommerceClient({...f,transport:async(url,options)=>{if(url===mcp){attempts++;return {status:502,data:{error:'unavailable'}};}return f.transport(url,options);}});
 await assert.rejects(client.refresh(),{code:'remote_error'});assert.equal(f.refreshes,1);assert.equal(attempts,1);assert.equal(f.state.rotation_in_flight,false);assert.equal(f.state.blocked_reason,undefined);
});

test('session rotates near-expiry own access token before the bounded provider verification path',async()=>{
 const f=syntheticProtocol(),client=new CommerceClient(f);await client.login();f.advance(255);await client.session();assert.equal(f.refreshes,1);
});

test('early rotation reserves both fifteen-second Auth reads plus forty-second verify budget and overhead',async()=>{
 const f=syntheticProtocol(),client=new CommerceClient(f);await client.login();f.advance(209);await client.session();assert.equal(f.refreshes,0);
 f.advance(1);await client.session();assert.equal(f.refreshes,1);
});
