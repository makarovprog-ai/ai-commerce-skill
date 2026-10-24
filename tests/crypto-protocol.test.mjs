import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createPublicKey,verify,privateDecrypt,publicEncrypt,createHash} from 'node:crypto';
import {generateKeys,mcpRequest,profile,BASE,verifyToken,b64,hash,encryptSession,decryptSession} from '../cli/crypto.mjs';
const now=1700000000;
export function releaseFixture(){
 const keys=generateKeys(),release=generateKeyPairSync('rsa',{modulusLength:3072});
 const wrapping_context=Buffer.from('synthetic-wrapping-context'); const dek=Buffer.alloc(32,17);
 const state={access_token:'synthetic-access-token',expires_at:now+300,packet_id:'packet',grant_id:'grant',device_id:'device',family_id:'family',dek_generation:1,wrapping_context:b64(wrapping_context),wrapped_dek:b64(publicEncrypt({key:keys.wrap_jwk,format:'jwk',oaepHash:'sha256',oaepLabel:wrapping_context},dek))};
 const jwks={keys:[{...release.publicKey.export({format:'jwk'}),use:'enc',alg:'RSA-OAEP-256',kid:'synthetic-key'}]};
 return {keys,release,state,jwks,dek};
}
test('MCP signs exact raw bytes, query target, DPoP and decryptable release transcript',()=>{
 const {keys,release,state,jwks,dek}=releaseFixture(); const body=Buffer.from(' {"method":"anything/new","params": {"x":1}}\r\n'); const url='https://api.sber-ai-pay.ru/mcp?x=1';
 const r=mcpRequest(keys,state,jwks,body,now,url);assert.equal(r.body,body);
 const h=r.headers;assert.equal(h['content-digest'],`sha-256=:${createHash('sha256').update(body).digest('base64')}:`);
 const [dh,dp,ds]=h.dpop.split('.'); const claims=JSON.parse(Buffer.from(dp,'base64url'));
 assert.equal(claims.htu,'https://api.sber-ai-pay.ru/mcp');assert.equal(claims.ath,hash(state.access_token));
 assert.ok(verify('sha256',Buffer.from(`${dh}.${dp}`),{key:createPublicKey({key:JSON.parse(Buffer.from(dh,'base64url')).jwk,format:'jwk'}),dsaEncoding:'ieee-p1363'},Buffer.from(ds,'base64url')));
 const packet=JSON.parse(Buffer.from(h['aipay-key-release'],'base64url'));
 const transcript=['aipay-mcp-release-v1','kid=synthetic-key','packet_id=packet','grant_id=grant','device_id=device','family_id=family','dek_generation=1',`context_hash=${hash(Buffer.from('synthetic-wrapping-context'))}`,`jkt=${keys.signJkt}`,`dpop_jti=${claims.jti}`,'method=POST',`url=${url}`,`body_hash=${hash(body)}`,`ath=${hash(state.access_token)}`,`expires_at=${now+120}`].join('\n');
 assert.deepEqual(privateDecrypt({key:release.privateKey,oaepHash:'sha256',oaepLabel:Buffer.from(transcript)},Buffer.from(packet.encrypted_dek,'base64url')),dek);
 const params=h['signature-input'].slice(6);const base=`"@method": POST\n"@target-uri": ${url}\n`+['content-type','content-digest','authorization','dpop','aipay-key-release'].map(n=>`"${n}": ${h[n]}\n`).join('')+`"@signature-params": ${params}`;
 const signature=Buffer.from(h.signature.slice(7,-1),'base64');const pub={key:createPublicKey(keys.sign),dsaEncoding:'ieee-p1363'};
 assert.ok(verify('sha256',Buffer.from(base),pub,signature));assert.ok(!verify('sha256',Buffer.from(base.replace(url,url+'2')),pub,signature));
 assert.throws(()=>privateDecrypt({key:release.privateKey,oaepHash:'sha256',oaepLabel:Buffer.from(transcript.replace(hash(body),'tampered'))},Buffer.from(packet.encrypted_dek,'base64url')));
});
test('MCP rejects wrong targets, expiry, excessive body and private release keys',()=>{
 const {keys,state,jwks}=releaseFixture();for(const url of ['http://api.sber-ai-pay.ru/mcp','https://elsewhere.test/mcp','https://api.sber-ai-pay.ru/mcp#x','https://api.sber-ai-pay.ru/mcp/'])assert.throws(()=>mcpRequest(keys,state,jwks,Buffer.from('{}'),now,url));
 assert.throws(()=>mcpRequest(keys,{...state,expires_at:now},jwks,Buffer.from('{}'),now));assert.throws(()=>mcpRequest(keys,state,jwks,Buffer.alloc(262145),now));
 assert.throws(()=>mcpRequest(keys,state,{keys:[{...jwks.keys[0],d:'private'}]},Buffer.from('{}'),now));
});
test('encrypted session rejects tampering and wrong device custody',()=>{
 const keys=generateKeys();const state={client_id:profile().client,rotation_in_flight:false,refresh_token:'synthetic-secret'};const envelope=encryptSession(keys,state);
 assert.deepEqual(decryptSession(keys,envelope,profile().client),state);
 assert.throws(()=>decryptSession(keys,{...envelope,rotation_in_flight:true},profile().client));
 assert.throws(()=>decryptSession(generateKeys(),envelope,profile().client));
 assert.throws(()=>decryptSession(keys,envelope,'other-client'));
});
