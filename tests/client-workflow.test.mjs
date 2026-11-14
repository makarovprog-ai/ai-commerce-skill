import test from 'node:test';
import assert from 'node:assert/strict';
import {CommerceClient} from '../cli/workflow.mjs';
import {syntheticProtocol} from './fixtures/protocol.mjs';
test('complete synthetic enrollment proves keys, PKCE and signed JWT then transmits exact unknown-operation bytes',async()=>{
 const f=syntheticProtocol(),client=new CommerceClient(f);const result=await client.login();assert.equal(result.status,'active');
 assert.equal(f.progress.length,1);assert.deepEqual(Object.keys(f.progress[0]).sort(),['user_code','verification_uri']);assert.equal(f.progress[0].user_code,'A2B3');
 const before=f.calls.length;assert.equal((await client.status()).status,'stored');assert.equal(f.calls.length,before);
 const body=Buffer.from(' {"method":"future/unknown","params":{"operation":"checkout"}}\r\n');const reply=await client.mcp(body);assert.equal(reply.status,200);assert.equal(f.calls.at(-1).options.body,body);
 assert.ok(!JSON.stringify(result).includes(f.state.access_token));assert.ok(!JSON.stringify(result).includes(f.state.refresh_token));
 await client.logout();assert.equal((await client.status()).status,'signed_out');
});
test('concurrent expired sessions rotate only once under custody lock',async()=>{
 const f=syntheticProtocol(),client=new CommerceClient(f);await client.login();f.advance(301);await Promise.all([client.session(),client.session()]);assert.equal(f.refreshes,1);assert.equal(f.state.rotation_in_flight,false);
});
test('ambiguous rotation durably requires login and cannot retry old refresh token',async()=>{
 const f=syntheticProtocol(),client=new CommerceClient(f);await client.login();f.failRefresh();await assert.rejects(client.refresh(),{code:'login_required'});assert.equal(f.state.rotation_in_flight,true);
 await assert.rejects(client.refresh(),{code:'login_required'});await assert.rejects(client.mcp(Buffer.from('{}')),{code:'login_required'});assert.equal(f.refreshes,1);
});
test('missing state and ambiguous refresh have different safe recovery reasons',async()=>{
 const f=syntheticProtocol(),client=new CommerceClient(f);
 await assert.rejects(client.tools(),{code:'login_required',reason:'session_missing'});
 await client.login();f.failRefresh();
 await assert.rejects(client.refresh(),{code:'login_required',reason:'refresh_outcome_unknown'});
 await assert.rejects(client.tools(),{code:'login_required',reason:'refresh_outcome_unknown'});
 assert.equal((await client.status()).reason,'refresh_outcome_unknown');assert.equal(f.refreshes,1);
});
test('tampered enrollment and user denial cannot escalate into browser/password fallback',async()=>{
 const f=syntheticProtocol();f.tamper();await assert.rejects(new CommerceClient(f).login(),{code:'invalid_response'});assert.equal(f.calls.length,1);assert.equal(f.progress.length,0);
 const denied=syntheticProtocol();denied.deny();await assert.rejects(new CommerceClient(denied).login(),{code:'denied'});assert.equal(denied.calls.filter(c=>c.url.endsWith('/token')).length,0);
});
test('cancelled clients never invoke signed transport',async()=>{
 const f=syntheticProtocol(),abort=new AbortController();abort.abort();await assert.rejects(new CommerceClient({...f,signal:abort.signal}).login(),{code:'cancelled'});assert.equal(f.calls.length,0);
});
test('logout is serialized under custody lock and missing state is a no-op',async()=>{
 let locked=false;const store={async withLock(callback,options){assert.equal(options.create,false);locked=true;try{return await callback(store);}finally{locked=false;}},async logout(){assert.equal(locked,true);}};
 assert.deepEqual(await new CommerceClient({store}).logout(),{status:'signed_out'});
 assert.deepEqual(await new CommerceClient({store:{withLock:callback=>callback(null)}}).logout(),{status:'signed_out'});
});
test('JWT signature tampering cannot persist an authenticated session',async()=>{
 const f=syntheticProtocol();const transport=async(url,options)=>{const r=await f.transport(url,options);if(url.endsWith('/token')){const parts=r.data.access_token.split('.');const claims=JSON.parse(Buffer.from(parts[1],'base64url'));claims.scope='connection:read';parts[1]=Buffer.from(JSON.stringify(claims)).toString('base64url');r.data.access_token=parts.join('.');}return r;};
 await assert.rejects(new CommerceClient({...f,transport}).login());assert.equal(f.state,undefined);
});
test('poll-only throttling and transient failures never retry token redemption or MCP business requests',async()=>{
 const f=syntheticProtocol();let polls=0,redemptions=0,mcp=0;
 const transport=async(url,options)=>{if(url.endsWith('/result')){polls++;if(polls===1)return {status:429,data:{code:'slow_down'},retryAfter:'10'};if(polls===2){const error=new Error('transient');error.code='network_error';throw error;}}
 if(url.endsWith('/token'))redemptions++;if(url==='https://api.sber-ai-pay.ru/mcp'){mcp++;throw Error('ambiguous synthetic MCP failure');}return f.transport(url,options);};
 const client=new CommerceClient({...f,transport});await client.login();assert.equal(polls,3);assert.equal(redemptions,1);await assert.rejects(client.mcp(Buffer.from('{}')));assert.equal(mcp,1);
});
