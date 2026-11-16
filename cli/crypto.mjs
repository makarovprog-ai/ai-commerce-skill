import {createHash,createPrivateKey,createPublicKey,generateKeyPairSync,randomBytes,sign as nodeSign,verify as nodeVerify,privateDecrypt,publicEncrypt,constants,createCipheriv,createDecipheriv} from 'node:crypto';

export const BASE='https://api.sber-ai-pay.ru/sberid-auth';
export const CLIENT='vps-companion',REDIRECT=`${BASE}/device/complete`;
export const MCP_SIGNATURE_HEADERS=Object.freeze({input:'ai-commerce-signature-input',signature:'ai-commerce-signature'});
const PROFILES=Object.freeze({diagnostic:Object.freeze({client:CLIENT,scope:'connection:read',audience:BASE}),mcp:Object.freeze({client:'vps-mcp-companion',scope:'mcp:invoke',audience:'https://api.sber-ai-pay.ru/mcp'})});
export function profile(name='mcp'){if(!Object.hasOwn(PROFILES,name))throw Error('invalid_profile');return PROFILES[name];}
export const b64=value=>Buffer.from(value).toString('base64url');
export function decode(value,max=65536){if(typeof value!=='string'||!value.length||value.length>max||!/^[A-Za-z0-9_-]+$/.test(value))throw Error('invalid_response');const bytes=Buffer.from(value,'base64url');if(b64(bytes)!==value)throw Error('invalid_response');return bytes;}
export const random=()=>randomBytes(32).toString('base64url');
export const hash=value=>createHash('sha256').update(value).digest('base64url');
export function thumb(j){return hash(JSON.stringify(j.kty==='EC'?{crv:j.crv,kty:j.kty,x:j.x,y:j.y}:{e:j.e,kty:j.kty,n:j.n}));}
export function generateKeys(){
  const sign=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),wrap=generateKeyPairSync('rsa',{modulusLength:2048,publicExponent:65537});
  return importKeys(sign.privateKey.export({format:'jwk'}),wrap.privateKey.export({format:'jwk'}));
}
export function importKeys(s,w){
  if(s?.kty!=='EC'||s.crv!=='P-256'||!s.d||w?.kty!=='RSA'||!w.d)throw Error('unsafe_storage');
  const sign=createPrivateKey({key:s,format:'jwk'}),wrap=createPrivateKey({key:w,format:'jwk'});
  if(wrap.asymmetricKeyDetails.modulusLength<2048||wrap.asymmetricKeyDetails.modulusLength>4096)throw Error('unsafe_storage');
  const sign_jwk={...createPublicKey(sign).export({format:'jwk'}),alg:'ES256',use:'sig'};
  const wrap_jwk={...createPublicKey(wrap).export({format:'jwk'}),alg:'RSA-OAEP-256',use:'enc'};
  if(s.x!==sign_jwk.x||s.y!==sign_jwk.y||w.n!==wrap_jwk.n||w.e!==wrap_jwk.e)throw Error('unsafe_storage');
  // Detect inconsistent private/public components before persisting or sending them.
  const probe=randomBytes(32);if(!nodeVerify('sha256',probe,{key:createPublicKey(sign),dsaEncoding:'ieee-p1363'},nodeSign('sha256',probe,{key:sign,dsaEncoding:'ieee-p1363'})))throw Error('unsafe_storage');
  const roundtrip=privateDecrypt({key:wrap,oaepHash:'sha256'},publicEncrypt({key:createPublicKey(wrap),oaepHash:'sha256'},probe));if(!roundtrip.equals(probe))throw Error('unsafe_storage');roundtrip.fill(0);probe.fill(0);
  return {sign,wrap,sign_jwk,wrap_jwk,signJkt:thumb(sign_jwk),wrapJkt:thumb(wrap_jwk)};
}
export const sign=(keys,bytes)=>b64(nodeSign('sha256',bytes,{key:keys.sign,dsaEncoding:'ieee-p1363'}));
export function unwrap(keys,ciphertext,label){return privateDecrypt({key:keys.wrap,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256',oaepLabel:label},decode(ciphertext));}
export function dpop(keys,method,url,accessToken,now=Math.floor(Date.now()/1000)){
  const h=b64(JSON.stringify({typ:'dpop+jwt',alg:'ES256',jwk:keys.sign_jwk})),p=b64(JSON.stringify({htm:method,htu:url,iat:now,jti:random(),...(accessToken?{ath:hash(accessToken)}:{})}));
  return `${h}.${p}.${sign(keys,Buffer.from(`${h}.${p}`))}`;
}
const label=(keys,client=CLIENT)=>Buffer.from(`auth-sberid-cli-session-v1\n${client}\n${keys.signJkt}\n${keys.wrapJkt}`);
export function encryptSession(keys,state){const dek=randomBytes(32),iv=randomBytes(12),aad=label(keys,state.client_id),cipher=createCipheriv('aes-256-gcm',dek,iv);try{
  cipher.setAAD(aad);const ciphertext=Buffer.concat([cipher.update(JSON.stringify(state)),cipher.final()]);
  return {version:1,rotation_in_flight:!!state.rotation_in_flight,wrapped_key:b64(publicEncrypt({key:createPublicKey(keys.wrap),oaepHash:'sha256',oaepLabel:aad},dek)),iv:b64(iv),ciphertext:b64(ciphertext),tag:b64(cipher.getAuthTag())};
}finally{dek.fill(0);}}
export function decryptSession(keys,envelope,client=CLIENT){if(envelope.version!==1||typeof envelope.rotation_in_flight!=='boolean')throw Error('unsafe_storage');const dek=unwrap(keys,envelope.wrapped_key,label(keys,client));try{
  if(dek.length!==32)throw Error('unsafe_storage');const decipher=createDecipheriv('aes-256-gcm',dek,decode(envelope.iv));decipher.setAAD(label(keys,client));decipher.setAuthTag(decode(envelope.tag));
  const clear=Buffer.concat([decipher.update(decode(envelope.ciphertext)),decipher.final()]);try{const state=JSON.parse(clear);if(state.rotation_in_flight!==envelope.rotation_in_flight)throw Error('unsafe_storage');return state;}finally{clear.fill(0);}
}finally{dek.fill(0);}}
export async function verifyToken(token,jwks,keys,context,now,p=profile()){
  if(typeof token!=='string'||token.length>8192)throw Error('invalid_response');const parts=token.split('.');if(parts.length!==3)throw Error('invalid_response');
  const h=JSON.parse(decode(parts[0])),c=JSON.parse(decode(parts[1]));
  if(Object.keys(h).some(k=>!['alg','typ','kid'].includes(k))||h.alg!=='RS256'||h.typ!=='at+jwt'||typeof h.kid!=='string'||!Array.isArray(jwks?.keys))throw Error('invalid_response');
  const matches=jwks.keys.filter(k=>k.kid===h.kid);if(matches.length!==1)throw Error('invalid_response');const j=matches[0];
  if(j.kty!=='RSA'||j.d||j.p||j.q||(j.alg&&j.alg!=='RS256')||(j.use&&j.use!=='sig'))throw Error('invalid_response');
  const pub=createPublicKey({key:j,format:'jwk'});if(pub.asymmetricKeyDetails.modulusLength<2048||!nodeVerify('sha256',Buffer.from(parts.slice(0,2).join('.')),pub,decode(parts[2])))throw Error('invalid_response');
  if(c.iss!==BASE||!(c.aud===p.audience||(Array.isArray(c.aud)&&c.aud.length===1&&c.aud[0]===p.audience))||c.client_id!==p.client||c.scope!==p.scope||c.cnf?.jkt!==keys.signJkt||!Number.isInteger(c.iat)||c.iat>now+5||!Number.isInteger(c.exp)||c.exp<=now||c.exp>now+305||c.exp-c.iat!==300||c.sub!==context.user_id||c.device_id!==context.device_id||c.grant_id!==context.grant_id||typeof c.family_id!=='string'||!c.jti)throw Error('invalid_response');
  return c;
}

// No parsing or classification of invocation bytes: authorization is server-side.
export function mcpRequest(keys,state,jwks,body,now=Math.floor(Date.now()/1000),url=PROFILES.mcp.audience){
  const target=new URL(url);
  if(target.origin!=='https://api.sber-ai-pay.ru'||target.pathname!=='/mcp'||target.username||target.password||target.hash||target.href!==url||url.length>4096||!Buffer.isBuffer(body)||body.length>262144||state.expires_at<=now)throw Error('invalid_request');
  if(!Array.isArray(jwks?.keys)||jwks.keys.length!==1)throw Error('invalid_response');
  const j=jwks.keys[0];
  if(j.kty!=='RSA'||j.use!=='enc'||j.alg!=='RSA-OAEP-256'||typeof j.kid!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(j.kid)||Object.keys(j).some(k=>!['kty','use','alg','kid','n','e','key_ops'].includes(k))||(j.key_ops&&(!Array.isArray(j.key_ops)||j.key_ops.length!==1||j.key_ops[0]!=='encrypt')))throw Error('invalid_response');
  const pub=createPublicKey({key:j,format:'jwk'});if(pub.asymmetricKeyDetails.modulusLength!==3072)throw Error('invalid_response');
  const proof=dpop(keys,'POST',target.origin+target.pathname,state.access_token,now),claims=JSON.parse(decode(proof.split('.')[1]));
  const expires=Math.min(now+120,state.expires_at);
  const transcript=['aipay-mcp-release-v1',`kid=${j.kid}`,`packet_id=${state.packet_id}`,`grant_id=${state.grant_id}`,`device_id=${state.device_id}`,`family_id=${state.family_id}`,`dek_generation=${state.dek_generation}`,`context_hash=${hash(decode(state.wrapping_context))}`,`jkt=${keys.signJkt}`,`dpop_jti=${claims.jti}`,'method=POST',`url=${url}`,`body_hash=${hash(body)}`,`ath=${hash(state.access_token)}`,`expires_at=${expires}`].join('\n');
  let dek,encrypted;
  try{dek=unwrap(keys,state.wrapped_dek,decode(state.wrapping_context));if(dek.length!==32)throw Error('invalid_response');encrypted=b64(publicEncrypt({key:pub,oaepHash:'sha256',oaepLabel:Buffer.from(transcript)},dek));}finally{dek?.fill(0);}
  const release=b64(JSON.stringify({version:1,kid:j.kid,packet_id:state.packet_id,dek_generation:state.dek_generation,expires_at:expires,encrypted_dek:encrypted}));
  const headers={accept:'application/json','content-type':'application/json','content-digest':`sha-256=:${createHash('sha256').update(body).digest('base64')}:`,authorization:`DPoP ${state.access_token}`,dpop:proof,'aipay-key-release':release};
  const params=`("@method" "@target-uri" "content-type" "content-digest" "authorization" "dpop" "aipay-key-release");created=${now};expires=${now+30};keyid="${keys.signJkt}";alg="ecdsa-p256-sha256"`;
  const base=`"@method": POST\n"@target-uri": ${url}\n`+['content-type','content-digest','authorization','dpop','aipay-key-release'].map(n=>`"${n}": ${headers[n]}\n`).join('')+`"@signature-params": ${params}`;
  headers[MCP_SIGNATURE_HEADERS.input]='aipay='+params;
  headers[MCP_SIGNATURE_HEADERS.signature]=`aipay=:${nodeSign('sha256',Buffer.from(base),{key:keys.sign,dsaEncoding:'ieee-p1363'}).toString('base64')}:`;
  return {method:'POST',headers,body};
}
