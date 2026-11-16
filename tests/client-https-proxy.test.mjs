import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const run=promisify(execFile);
const transport=new URL('../cli/http.mjs',import.meta.url).href;
const errors=new URL('../cli/errors.mjs',import.meta.url).href;

test('HTTPS proxy routes only through CONNECT, keeping TLS and refresh delivery guarantees',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ai-commerce-proxy-test-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const key=join(dir,'key.pem'),cert=join(dir,'cert.pem');
 try{
  await run('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=fixture',
   '-addext','subjectAltName=DNS:origin.invalid,IP:127.0.0.1','-keyout',key,'-out',cert]);
 }catch(error){if(error.code==='ENOENT'){t.skip('OpenSSL not installed');return;}throw error;}
 const requests=[],tunnels=[],sockets=new Set();
 async function listen(server){
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
  return server.address().port;
 }
 const tlsOptions={key:await readFile(key),cert:await readFile(cert)};
 const origin=await listen(https.createServer(tlsOptions,(req,res)=>{
  const chunks=[];req.on('data',chunk=>chunks.push(chunk));
  req.on('end',()=>{
   requests.push({method:req.method,path:req.url,authorization:req.headers.authorization,proxyAuthorization:req.headers['proxy-authorization'],body:Buffer.concat(chunks).toString()});
   if(chunks[0]?.toString()==='fixture-refresh-no-reply'){res.destroy();return;}
   res.writeHead(200,{'content-type':'application/json'});res.end('{}');
  });
 }));
 function tunnel(reject=false){return (req,client,head)=>{
  tunnels.push({target:req.url,authorization:req.headers['proxy-authorization'],originAuthorization:req.headers.authorization});
  client.on('error',()=>{});
  if(reject){client.write('HTTP/1.1 407 fixture-private-reason\r\nContent-Length: 0\r\n\r\n');client.resume();return;}
  const upstream=net.connect(origin,'127.0.0.1',()=>{
   client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
   if(head.length)upstream.write(head);
   client.pipe(upstream).pipe(client);
  });
  upstream.on('error',()=>client.destroy());client.once('close',()=>upstream.destroy());
 };}
 const proxy=await listen(http.createServer().on('connect',tunnel()));
 const secureProxy=await listen(https.createServer(tlsOptions).on('connect',tunnel()));
 const refused=await listen(http.createServer().on('connect',tunnel(true)));
 const silent=await listen(http.createServer().on('connect',(_req,socket)=>socket.resume()));
 const stalledTLS=await listen(http.createServer().on('connect',(_req,socket)=>{
  socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');socket.resume();
 }));
 const proxyURL=`http://fixture-proxy:fixture-pass@127.0.0.1:${proxy}`;
 async function probe({env={},trusted=true,host='origin.invalid',token=false,noReply=false,timeout=3200,cancel=false,nativeAgent=false}={}){
  const script=`import {requestJSON,tokenRequestWasNotSent} from ${JSON.stringify(transport)};
  import {publicError} from ${JSON.stringify(errors)};
  ${nativeAgent?`process.env.HTTPS_PROXY=${JSON.stringify(env.HTTPS_PROXY)};`:''}
  const token=${token},path='/sberid-auth/'+(token?'token':'jwks');
  const signal=${cancel} ? AbortSignal.timeout(200) : undefined;
  try{const r=await requestJSON('https://api.sber-ai-pay.ru'+path,token?
    {method:'POST',signal,headers:{Authorization:'fixture-origin'},body:${JSON.stringify(noReply?'fixture-refresh-no-reply':'fixture-refresh')}}:{method:'GET',signal,reportPeer:true},
    {mapURL:()=>${JSON.stringify(`https://${host}:${origin}`)}+path,timeoutMs:${timeout}});
    console.log(JSON.stringify({status:r.status,verified:r.tls?.verified}));
  }catch(error){console.log(JSON.stringify({error:publicError(error),notSent:tokenRequestWasNotSent(error)}));}`;
  const vars={...process.env};
  for(const name of Object.keys(vars))if(/^(https?_proxy|no_proxy|all_proxy|node_debug|node_debug_native|node_options|node_extra_ca_certs|node_tls_reject_unauthorized|node_use_env_proxy)$/i.test(name))delete vars[name];
  const {stdout,stderr}=await run(process.execPath,['--input-type=module','-e',script],{
   env:{...vars,...(trusted?{NODE_EXTRA_CA_CERTS:cert}:{}),HTTPS_PROXY:proxyURL,...env,
    ...(nativeAgent?{HTTPS_PROXY:proxyURL,NODE_USE_ENV_PROXY:'1'}:{})},timeout:cancel?2500:8000
  });
  assert.equal(stderr,'');
  assert.ok(!/fixture-(pass|proxy|private-reason|origin|refresh)/.test(stdout));
  return JSON.parse(stdout);
 }

 assert.deepEqual(await probe(),{status:200,verified:true});
 assert.deepEqual(tunnels.at(-1),{target:`origin.invalid:${origin}`,authorization:`Basic ${Buffer.from('fixture-proxy:fixture-pass').toString('base64')}`,originAuthorization:undefined});
 assert.deepEqual(await probe({env:{https_proxy:`https://127.0.0.1:${secureProxy}`,HTTPS_PROXY:'invalid'},token:true}),{status:200});
 assert.deepEqual(requests.at(-1),{method:'POST',path:'/sberid-auth/token',authorization:'fixture-origin',proxyAuthorization:undefined,body:'fixture-refresh'});
 const tunnelCount=tunnels.length;
 assert.deepEqual(await probe({host:'127.0.0.1',env:{NO_PROXY:'127.0.0.1'}}),{status:200,verified:true});
 assert.equal(tunnels.length,tunnelCount);

 const requestCount=requests.length;
 for(const [options,cause] of [
  [{trusted:false},'tls'],
  [{trusted:false,env:{HTTPS_PROXY:`https://127.0.0.1:${secureProxy}`}},'tls'],
  [{host:'name-mismatch.invalid'},'tls'],
  [{host:'127.0.0.1',env:{HTTPS_PROXY:`http://127.0.0.1:${refused}`}},'proxy'],
  [{env:{HTTPS_PROXY:`http://127.0.0.1:${silent}`},timeout:250},'timeout'],
  [{env:{HTTPS_PROXY:`http://127.0.0.1:${stalledTLS}`},timeout:250},'timeout'],
  [{env:{HTTPS_PROXY:'unsupported://fixture-pass@proxy.invalid'}},'proxy'],
  [{env:{HTTPS_PROXY:'http://fixture-pass@127.0.0.1:notaport'},nativeAgent:true},'proxy'],
 ]){
  const failure=await probe({...options,token:true});
  assert.equal(failure.error?.code,'network_error');
  assert.equal(failure.error?.details?.cause,cause);
  assert.equal(failure.error?.details?.delivery,'not_sent');
  assert.equal(failure.notSent,true);
 }
 assert.equal(requests.length,requestCount);
 assert.deepEqual(await probe({token:true,env:{HTTPS_PROXY:`http://127.0.0.1:${stalledTLS}`},cancel:true,timeout:5000}),
  {error:{code:'cancelled'},notSent:true});
 const ambiguous=await probe({token:true,noReply:true});
 assert.equal(ambiguous.error?.code,'network_error');
 assert.equal(ambiguous.error?.details?.delivery,undefined);
 assert.equal(ambiguous.notSent,false);
 assert.equal(requests.length,requestCount+1);
});

test('CLI rejects native network debug before proxy credentials can be logged',async()=>{
 const bin=fileURLToPath(new URL('../bin/ai-commerce.mjs',import.meta.url));
 const proxyAuth='fixture-startup:fixture-password';
 await assert.rejects(run(process.execPath,[bin,'doctor','--network'],{env:{
  PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,NODE_DEBUG:'http,https',NODE_USE_ENV_PROXY:'1',
  HTTPS_PROXY:`http://${proxyAuth}@127.0.0.1:1`,
 },timeout:4000}),error=>{
  assert.equal(error.code,1);
  assert.equal(JSON.parse(error.stdout).error.code,'unsafe_environment');
  assert.ok(!error.stderr.includes(proxyAuth));
  assert.ok(!error.stderr.includes(Buffer.from(proxyAuth).toString('base64')));
  return true;
 });
});
