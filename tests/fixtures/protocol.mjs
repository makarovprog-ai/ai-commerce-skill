import assert from 'node:assert/strict';
import {generateKeyPairSync,createPublicKey,publicEncrypt,verify,sign,randomBytes} from 'node:crypto';
import {BASE,REDIRECT,generateKeys,b64,hash,thumb} from '../../cli/crypto.mjs';
import {ClientError} from '../../cli/errors.mjs';

export function syntheticProtocol({enrollmentDelay=0,keys=generateKeys()}={}){
 let clock=1700000000,enrollment,challenge,tokenCounter=0,refreshes=0,calls=[],progress=[];
 const issuer=generateKeyPairSync('rsa',{modulusLength:2048});
 const release=generateKeyPairSync('rsa',{modulusLength:3072});
 const id='00000000-0000-4000-8000-000000000001',device='00000000-0000-4000-8000-000000000002',grant='00000000-0000-4000-8000-000000000003',packet='00000000-0000-4000-8000-000000000004',family='00000000-0000-4000-8000-000000000005';
 const requestId='r'.repeat(43),code='c'.repeat(43),dek=randomBytes(32);let state,blocked=false,queue=Promise.resolve(),failRefresh=false,tamperTranscript=false,denied=false;
 const store={
  withLock(callback){const p=queue.then(()=>callback(store));queue=p.catch(()=>{});return p;},
  async keys(){return keys;},async session(){return state?structuredClone(state):null;},async save(_,next){state=structuredClone(next);},async logout(){state=null;},
  async block(){blocked=true;},async blocked(){return blocked;},async clearBlock(){blocked=false;},
 };
 const context=Buffer.from(['auth-sberid-v1',`packet_id=${packet}`,`user_id=${id}`,`device_id=${device}`,'environment=synthetic',`wrap_jkt=${keys.wrapJkt}`,'dek_generation=1'].join('\n'));
 const wrapped=b64(publicEncrypt({key:createPublicKey(keys.wrap),oaepHash:'sha256',oaepLabel:context},dek));
 function token(){
  const claims={iss:BASE,aud:'https://api.sber-ai-pay.ru/mcp',client_id:'vps-mcp-companion',scope:'mcp:invoke',cnf:{jkt:keys.signJkt},iat:clock,exp:clock+300,sub:id,device_id:device,grant_id:grant,family_id:family,jti:`jti-${++tokenCounter}`};
  const h=b64(JSON.stringify({alg:'RS256',typ:'at+jwt',kid:'issuer'})),p=b64(JSON.stringify(claims));
  return {token_type:'DPoP',expires_in:300,access_token:`${h}.${p}.${b64(sign('sha256',Buffer.from(`${h}.${p}`),issuer.privateKey))}`,refresh_token:String(tokenCounter).padStart(43,'t'),scope:'mcp:invoke',user_id:id,device_id:device,grant_id:grant,existing_user:true,packet_id:packet,wrapped_dek:wrapped,wrapping_context:b64(context),dek_generation:1};
 }
 function checkProof(url,options){
  const proof=options.headers?.DPoP??options.headers?.dpop;if(!proof)return;
  const [h,p,s]=proof.split('.'),header=JSON.parse(Buffer.from(h,'base64url')),claims=JSON.parse(Buffer.from(p,'base64url'));
  assert.ok(verify('sha256',Buffer.from(`${h}.${p}`),{key:createPublicKey({key:header.jwk,format:'jwk'}),dsaEncoding:'ieee-p1363'},Buffer.from(s,'base64url')));
  assert.equal(thumb(header.jwk),keys.signJkt);assert.equal(claims.htm,options.method);assert.equal(claims.htu,url);assert.equal(claims.iat,clock);
  if(options.headers.authorization)assert.equal(claims.ath,hash(options.headers.authorization.slice(5)));
 }
 async function transport(url,options={}){
  calls.push({url,options});checkProof(url,options);const path=url.replace(BASE,'');
  if(path==='/device/requests'){
   clock+=enrollmentDelay;
   enrollment=JSON.parse(options.body);assert.equal(enrollment.client_id,'vps-mcp-companion');assert.equal(enrollment.redirect_uri,REDIRECT);assert.equal(enrollment.code_challenge_method,'S256');
   const input=Buffer.from(['auth-sberid-cross-device-enrollment-v1',requestId,'n'.repeat(43),keys.signJkt,keys.wrapJkt,enrollment.client_id,REDIRECT,enrollment.state,enrollment.code_challenge,'S256','mcp:invoke',String(clock+600)].join('\n'));challenge=Buffer.alloc(32,9);
   return {status:201,data:{request_id:requestId,signing_input:b64(tamperTranscript?Buffer.from(input.toString().replace('mcp:invoke','connection:read')):input),wrapping_challenge:b64(publicEncrypt({key:createPublicKey(keys.wrap),oaepHash:'sha256',oaepLabel:input},challenge)),wrapping_label:b64(input),expires_at:clock+600,proof_expires_at:clock+120}};
  }
  if(path.endsWith('/prove')){
   const proof=JSON.parse(options.body);const input=Buffer.from(['auth-sberid-cross-device-enrollment-v1',requestId,'n'.repeat(43),keys.signJkt,keys.wrapJkt,enrollment.client_id,REDIRECT,enrollment.state,enrollment.code_challenge,'S256','mcp:invoke',String(clock+600)].join('\n'));
   assert.deepEqual(Buffer.from(proof.wrapping_proof,'base64url'),challenge);assert.ok(verify('sha256',input,{key:createPublicKey(keys.sign),dsaEncoding:'ieee-p1363'},Buffer.from(proof.signing_proof,'base64url')));
   return {status:200,data:{status:'pending',verification_uri:`${BASE}/device/${requestId}`,user_code:'A2B3',expires_at:clock+600,interval:5}};
  }
  if(path.endsWith('/result'))return denied?{status:410,data:{code:'denied'}}:{status:200,data:{status:'ready',client_id:enrollment.client_id,redirect_uri:REDIRECT,state:enrollment.state,code,code_expires_at:clock+60}};
  if(path==='/token'){
   const form=new URLSearchParams(options.body);assert.equal(form.get('client_id'),'vps-mcp-companion');
   if(form.get('grant_type')==='refresh_token'){refreshes++;assert.equal(state.rotation_in_flight,true);assert.equal(form.get('refresh_token'),state.refresh_token);if(failRefresh)throw new ClientError('network_error');}
   else{assert.equal(form.get('code'),code);assert.equal(hash(form.get('code_verifier')),enrollment.code_challenge);assert.equal(form.get('redirect_uri'),REDIRECT);}
   return {status:200,data:token()};
  }
  if(path==='/jwks')return {status:200,data:{keys:[{...issuer.publicKey.export({format:'jwk'}),kid:'issuer',alg:'RS256',use:'sig'}]}};
  if(path==='/mcp-session')return {status:200,data:{status:'active',user_id:id,device_id:device,grant_id:grant,family_id:family,packet_id:packet,wrapped_dek:wrapped,wrapping_context:b64(context),dek_generation:1}};
  if(path==='/release-jwks')return {status:200,data:{keys:[{...release.publicKey.export({format:'jwk'}),kid:'release',alg:'RSA-OAEP-256',use:'enc'}]}};
  if(url==='https://api.sber-ai-pay.ru/mcp')return {status:200,data:{jsonrpc:'2.0',id:1,result:{tools:[]}}};
  throw Error('unexpected synthetic endpoint');
 }
 return {store,keys,transport,now:()=>clock,sleep:async ms=>{clock+=ms/1000;},output:p=>progress.push(p),calls,progress,advance:s=>clock+=s,get state(){return state;},get blocked(){return blocked;},get refreshes(){return refreshes;},failRefresh:()=>failRefresh=true,tamper:()=>tamperTranscript=true,deny:()=>denied=true};
}
