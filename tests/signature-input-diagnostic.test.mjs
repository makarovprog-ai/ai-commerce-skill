import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {main} from '../cli/app.mjs';
import {diagnosticMain} from '../bin/ai-commerce-diagnostic.mjs';
import {requestJSON} from '../cli/http.mjs';
import {CommerceClient} from '../cli/workflow.mjs';
import {syntheticProtocol} from './fixtures/protocol.mjs';

async function run(args,deps={},entry=diagnosticMain) {
 const lines=[];
 const code=await entry(args,{...deps,write:line=>lines.push(line)});
 return {code,value:JSON.parse(lines.at(-1)),lines};
}

test('signature format self-test is synthetic, offline, and returns only fixed diagnostics',async()=>{
 const forbidden=()=>assert.fail('diagnostic must not use network, custody or updater');
 const {code,value,lines}=await run(['doctor','--signature-input'],{
  transport:forbidden,store:{withLock:forbidden},updates:{check:forbidden,install:forbidden},
 });
 assert.equal(code,0);
 assert.equal(lines.length,1);
 assert.deepEqual(value.data.signature_input,{present:true,expected_format:true});
 assert.equal(value.data.mode,'offline_synthetic');
 assert.match(value.data.runtime.cli,/^\d+\.\d+\.\d+-diagnostic\.\d+$/);
 for(const args of [['doctor','--signature-input','--network'],['doctor','--signature-input','--state-dir','x'],['tools','--diagnose-signature-input','--from','-'],['login']]){
  assert.equal((await run(args,{transport:forbidden})).value.error.code,'usage');
 }
});

test('opt-in tools diagnosis describes a single Node request, includes correlation, and never prints header values',async t=>{
 const f=syntheticProtocol();await new CommerceClient(f).login();
 const marker='must-not-appear-in-output';
 const received=[];
 const requestId='1234567890abcdef1234567890abcdef';
 const local=http.createServer((req,res)=>{
  req.resume();req.on('end',()=>{
   received.push(Object.hasOwn(req.headers,'signature-input'));
   res.writeHead(401,{'content-type':'application/json','x-request-id':requestId});res.end('{}');
  });
 }).listen(0,'127.0.0.1');
 await once(local,'listening');
 t.after(()=>{local.closeAllConnections();local.close();});
 for(const [mode,present,expected_format] of [['valid',true,true],['invalid',true,false],['absent',false,false],['ordinary',true,true]]){
  let outbound;
  const transport=(url,options)=>{
   if(!url.endsWith('/mcp'))return f.transport(url,options);
   const headers={...options.headers};
   if(mode==='invalid')headers['signature-input']=marker;
   if(mode==='absent')delete headers['signature-input'];
   outbound=headers['signature-input'];
   return requestJSON(url,{...options,headers},{mapURL:()=>`http://127.0.0.1:${local.address().port}/mcp`});
  };
  const args=mode==='ordinary'?['tools']:['tools','--diagnose-signature-input'];
  const {code,value,lines}=await run(args,{...f,transport},mode==='ordinary'?main:diagnosticMain);
  assert.equal(code,1);
  assert.equal(value.error.diagnostics.request_id,requestId);
  assert.deepEqual(value.signature_input,mode==='ordinary'?undefined:{stage:'before_send',present,expected_format});
  assert.ok(!lines.join('').includes(marker));
  if(outbound)assert.ok(!lines.join('').includes(outbound));
 }
 assert.deepEqual(received,[true,true,false,true]);
});

test('preflight failure does not report a client header or start another request',async()=>{
 const f=syntheticProtocol();
 const {code,value}=await run(['tools','--diagnose-signature-input'],f);
 assert.equal(code,1);assert.equal(value.error.code,'login_required');
 assert.deepEqual(value.signature_input,{stage:'not_reached'});
 assert.equal(f.calls.length,0);
});

test('successful single-request diagnosis suppresses the response and session details',async t=>{
 const f=syntheticProtocol();await new CommerceClient(f).login();
 const marker='synthetic-reflected-response-should-not-appear';const incoming=[];let updates=0;
 f.calls.length=0;
 const local=http.createServer((req,res)=>{
  const chunks=[];req.on('data',chunk=>chunks.push(chunk));
  req.on('end',()=>{incoming.push({method:req.method,body:JSON.parse(Buffer.concat(chunks))});res.setHeader('content-type','application/json');res.end(JSON.stringify({value:marker}));});
 }).listen(0,'127.0.0.1');
 await once(local,'listening');t.after(()=>{local.closeAllConnections();local.close();});
 const transport=(url,options)=>url.endsWith('/mcp')?requestJSON(url,options,{mapURL:()=>`http://127.0.0.1:${local.address().port}/mcp`}):f.transport(url,options);
 const {code,value,lines}=await run(['tools','--diagnose-signature-input'],{...f,transport,updates:{check(){updates++;}}});
 assert.equal(code,0);assert.ok(!lines.join('').includes(marker));
 assert.deepEqual(incoming,[{method:'POST',body:{jsonrpc:'2.0',id:1,method:'tools/list',params:{}}}]);
 assert.deepEqual(f.calls.map(x=>new URL(x.url).pathname),['/sberid-auth/mcp-session','/sberid-auth/release-jwks']);
 assert.equal(updates,0);
 assert.deepEqual(value,{version:1,ok:true,signature_input:{stage:'before_send',present:true,expected_format:true}});
});

test('diagnostic entrypoint refuses native network debugging even without HTTPS_PROXY',()=>{
 const env={...process.env};
 for(const name of Object.keys(env))if(/^(https?_proxy|no_proxy|node_debug|node_debug_native|node_use_env_proxy|node_options|node_tls_reject_unauthorized)$/i.test(name))delete env[name];
 const bin=fileURLToPath(new URL('../bin/ai-commerce-diagnostic.mjs',import.meta.url));
 const r=spawnSync(process.execPath,[bin,'doctor','--signature-input'],{env:{...env,NODE_DEBUG:'https'},encoding:'utf8',timeout:5000});
 assert.equal(r.status,1);
 assert.deepEqual(JSON.parse(r.stdout),{version:1,ok:false,error:{code:'unsafe_environment'}});
});
