import test from 'node:test';
import assert from 'node:assert/strict';
import {main} from '../cli/app.mjs';
import {CommerceClient} from '../cli/workflow.mjs';
import {syntheticProtocol} from './fixtures/protocol.mjs';

test('tool projection preserves default output, selects an exact schema and keeps summary small',async()=>{
 const f=syntheticProtocol();await new CommerceClient(f).login();let sends=0;
 const tool={name:'search_catalog_v3',title:'Search',description:'Find products',annotations:{readOnlyHint:true},inputSchema:{type:'object'},outputSchema:{type:'object'},_meta:{revision:2}};
 const values=[],data={jsonrpc:'2.0',id:1,result:{tools:[tool,{name:'create_checkout',description:'Create',inputSchema:{type:'object'}}]}};
 const deps={...f,write:v=>values.push(JSON.parse(v)),transport:async(url,options)=>{
  if(url==='https://api.sber-ai-pay.ru/mcp'){sends++;assert.equal(JSON.parse(options.body).method,'tools/list');return {status:200,data};}
  return f.transport(url,options);
 }};
 assert.equal(await main(['tools','--summary'],deps),0);
 assert.deepEqual(values.at(-1).data.tools[0],{name:tool.name,title:'Search',description:'Find products',annotations:{readOnlyHint:true}});
 assert.equal(await main(['tools','--name','search_catalog_v3'],deps),0);assert.deepEqual(values.at(-1).data,{tool});
 assert.equal(await main(['tools'],deps),0);assert.deepEqual(values.at(-1).data,data);
 assert.equal(await main(['tools','--name','missing'],deps),1);assert.equal(values.at(-1).error.code,'invalid_request');assert.equal(sends,4);
});
test('tool flags reject ambiguity before network and JSON-RPC errors never become an empty successful list',async()=>{
 const f=syntheticProtocol();await new CommerceClient(f).login();const values=[];
 const deps={...f,write:v=>values.push(JSON.parse(v))};const before=f.calls.length;
 for(const args of [['tools','--summary','--name','x'],['tools','--summary','--summary'],['mcp','--summary'],['tools','--name'],['tools','--summary','yes']]){
  assert.equal(await main(args,deps),1);assert.equal(values.at(-1).error.code,'usage');
 }assert.equal(f.calls.length,before);
 for(const data of [{jsonrpc:'2.0',error:{code:-32603,message:'secret response'}},{result:{}},{result:{tools:[{name:'x'},{name:'x'}]}}]){
  const transport=async(url,o)=>url==='https://api.sber-ai-pay.ru/mcp'?{status:200,data}:f.transport(url,o);
  assert.equal(await main(['tools','--summary'],{...deps,transport}),1);assert.equal(values.at(-1).ok,false);assert.ok(!JSON.stringify(values.at(-1)).includes('secret response'));
 }
});
