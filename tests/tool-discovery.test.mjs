import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtemp,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {main} from '../cli/app.mjs';
import {CommerceClient} from '../cli/workflow.mjs';
import {syntheticProtocol} from './fixtures/protocol.mjs';

const mcp='https://api.sber-ai-pay.ru/mcp';
const page=(tools,extra={},id=1)=>({jsonrpc:'2.0',id,result:{tools,...extra}});
const entry=name=>({name,inputSchema:{type:'object'}});
const offlineInput=value=>Readable.from([typeof value==='string'?value:JSON.stringify(value)]);

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

test('one fresh discovery supports repeated offline projections from stdin and file with no custody or update I/O',async t=>{
 const f=syntheticProtocol();await new CommerceClient(f).login();const values=[],calls=[];
 const renamed={name:'find_goods_today',title:'Find',annotations:{readOnlyHint:true},
  inputSchema:{type:'object',properties:{access_token:{$ref:'#/$defs/opaque'}},$defs:{opaque:{type:'string'}},'x-extra':{untouched:true}},
  outputSchema:{type:'object',properties:{wrapped_dek:{type:'number'}}},vendor:{tag:'kept'}};
 const data=page([renamed,entry('other')],{_meta:{revision:7}});
 const deps={...f,write:v=>values.push(JSON.parse(v)),updates:{async check(){calls.push('update');}},transport:async(url,options)=>{
  calls.push(url);return url===mcp?{status:200,data}:f.transport(url,options);
 }};
 const baseStore=f.store;const locks=[];deps.store={...baseStore,withLock(...a){locks.push(a[1]);return baseStore.withLock(...a);}};
 assert.equal(await main(['tools'],deps),0);const snapshot=values.at(-1);assert.deepEqual(snapshot.data,data);
 const dir=await mkdtemp(join(await realpath(tmpdir()),'commerce-tools-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=join(dir,'snapshot.json');await writeFile(file,JSON.stringify(snapshot));
 assert.equal(await main(['tools','--from',file,'--name',renamed.name],deps),0);assert.deepEqual(values.at(-1).data,{tool:renamed});
 assert.equal(await main(['tools','--from','-','--summary'],{...deps,input:offlineInput(snapshot)}),0);
 assert.deepEqual(values.at(-1).data,{tools:[{name:renamed.name,title:'Find',annotations:{readOnlyHint:true}},{name:'other'}]});
 assert.equal(await main(['tools','--from','-'],{...deps,input:offlineInput(snapshot)}),0);assert.deepEqual(values.at(-1),snapshot);
 assert.deepEqual(calls.map(u=>u.split('/').at(-1)),['mcp-session','release-jwks','mcp','update']);
 assert.deepEqual(locks,[{create:false}]);
});

test('offline catalog rejects errors, summaries, malformed models and auth flags without side effects',async()=>{
 const valid=page([entry('find')]),values=[],calls=[];
 const unexpected=()=>{calls.push('I/O');throw Error('offline');};
 const deps={store:{withLock:unexpected},transport:unexpected,updates:{check:unexpected},write:v=>values.push(JSON.parse(v))};
 const wrap=data=>({version:1,ok:true,data});
 for(const snapshot of ['{',null,{...wrap(valid),version:2},{...wrap(valid),ok:false},{...wrap(valid),error:{}},
  wrap({tools:[entry('find')]}),wrap({tool:entry('find')}),wrap({...valid,jsonrpc:'1.0'}),wrap({...valid,id:null}),
  wrap({...valid,error:{code:-32603,message:'untrusted'}}),wrap({jsonrpc:'2.0',id:1,error:{code:-32603,message:'untrusted'}}),
  wrap(page([entry('find')],{nextCursor:'more'})),wrap(page([entry('find')],{nextCursor:null})),
  wrap(page([entry('find'),entry('find')])),wrap(page([{name:'find'}])),wrap(page([{...entry('find'),outputSchema:[]}]))]){
  assert.equal(await main(['tools','--from','-'],{...deps,input:offlineInput(snapshot)}),1);
  assert.deepEqual(values.at(-1),{version:1,ok:false,error:{code:'invalid_request'}});
 }
 for(const flags of [['--profile','mcp'],['--state-dir','unused'],['--passphrase-fd','3'],['--auth','unused'],['--summary','--name','find']]){
  assert.equal(await main(['tools','--from','-',...flags],{...deps,input:offlineInput(wrap(valid))}),1);
  assert.equal(values.at(-1).error.code,'usage');
 }
 assert.deepEqual(calls,[]);
});

test('snapshot reads allow more than 256 KiB but enforce 8 MiB and retain file guards',async t=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'commerce-catalog-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=join(dir,'catalog.json'),link=join(dir,'link.json'),values=[];
 const snapshot={version:1,ok:true,data:page([{...entry('find'),inputSchema:{type:'object',description:'x'.repeat(270000)}}])};
 const deps={write:v=>values.push(JSON.parse(v))};
 await writeFile(file,JSON.stringify(snapshot));await symlink(file,link);
 assert.equal(await main(['tools','--from',file,'--summary'],deps),0);assert.deepEqual(values.at(-1).data,{tools:[{name:'find'}]});
 assert.equal(await main(['tools','--from',link],deps),1);assert.equal(values.at(-1).error.code,'invalid_request');
 const oversized=' '.repeat(8*1024*1024)+JSON.stringify(snapshot);
 await writeFile(file,oversized);
 for(const path of [file,'-']){
  assert.equal(await main(['tools','--from',path],{...deps,input:offlineInput(oversized)}),1);
  assert.equal(values.at(-1).error.code,'invalid_request');
 }
});

test('paged discovery signs every original page request and selects only after one complete sequence',async()=>{
 const f=syntheticProtocol();await new CommerceClient(f).login();const values=[],calls=[],locks=[];
 const store={...f.store,withLock(...args){locks.push(args[1]);return f.store.withLock(...args);}};
 const first=entry('first'),last={...entry('later_renamed'),outputSchema:{type:'object',$defs:{x:{type:'string'}}}};
 const deps={...f,store,write:v=>values.push(JSON.parse(v)),transport:async(url,options)=>{
  calls.push(url.split('/').at(-1));
  if(url!==mcp)return f.transport(url,options);
  const payload=JSON.parse(options.body);
  assert.equal(options.headers['content-digest'],`sha-256=:${createHash('sha256').update(options.body).digest('base64')}:`);
  assert.ok(options.headers.signature&&options.headers['aipay-key-release']);
  if(payload.id===1){
   assert.deepEqual(payload,{jsonrpc:'2.0',id:1,method:'tools/list',params:{}});
   return {status:200,data:page([first],{nextCursor:'opaque + / =',_meta:{revision:5}})};
  }
  assert.deepEqual(payload,{jsonrpc:'2.0',id:2,method:'tools/list',params:{cursor:'opaque + / ='}});
  return {status:200,data:page([last],{},2)};
 }};
 assert.equal(await main(['tools'],deps),0);assert.deepEqual(values.at(-1).data,page([first,last],{_meta:{revision:5}}));
 assert.equal(await main(['tools','--from','-','--name','later_renamed'],{...deps,input:offlineInput(values.at(-1))}),0);
 assert.deepEqual(values.at(-1).data,{tool:last});
 assert.deepEqual(calls,['mcp-session','release-jwks','mcp','mcp']);assert.deepEqual(locks,[{create:false}]);
});

test('discovery rejects bad pages and bounds pagination without returning partial output',async()=>{
 const f=syntheticProtocol();await new CommerceClient(f).login();const values=[];
 const cases=[
  {label:'wrong RPC version',code:'invalid_response',count:1,response:()=>({...page([]),jsonrpc:'1.0'})},
  {label:'wrong ID',code:'invalid_response',count:1,response:()=>page([],{},2)},
  {label:'wrong schema type',code:'invalid_response',count:1,response:()=>page([{name:'x',inputSchema:false}])},
  {label:'missing result',code:'invalid_response',count:1,response:()=>({jsonrpc:'2.0',id:1})},
  {label:'empty cursor',code:'invalid_response',count:1,response:()=>page([],{nextCursor:''})},
  {label:'repeated cursor',code:'invalid_response',count:2,response:i=>page([],{nextCursor:'same'},i)},
  {label:'duplicates across pages',code:'invalid_response',count:2,response:i=>page([entry('same')],i===1?{nextCursor:'next'}:{},i)},
  {label:'error on page 2',code:'remote_error',count:2,response:i=>i===1?page([],{nextCursor:'next'}):{jsonrpc:'2.0',id:i,error:{code:-32603,message:'do-not-print'}}},
  {label:'count bound',code:'invalid_response',count:20,response:i=>page([],{nextCursor:`page-${i}`},i)},
  {label:'size bound',code:'invalid_response',count:2,response:i=>page([],{padding:'a'.repeat(2200000),...(i===1?{nextCursor:'next'}:{})},i)},
 ];
 for(const {label,code,count,response} of cases){
  let attempts=0;
  const deps={...f,write:v=>values.push(JSON.parse(v)),transport:async(url,o)=>url===mcp?{status:200,data:response(++attempts)}:f.transport(url,o)};
  assert.equal(await main(['tools'],deps),1,label);
  const actual=values.at(-1);
  const diagnostics=['repeated cursor','count bound','size bound'].includes(label)?{}:{diagnostics:{phase:'tools/list',http_status:200,time_utc:actual.error.diagnostics?.time_utc}};
  assert.deepEqual(actual,{version:1,ok:false,error:{code,...diagnostics}},label);
  assert.equal(attempts,count,label);
 }
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
