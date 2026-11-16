#!/usr/bin/env node
import {generateKeyPairSync,publicEncrypt,randomBytes} from 'node:crypto';
import {main} from '../cli/app.mjs';
import {generateKeys,mcpRequest,b64} from '../cli/crypto.mjs';
import {assertEnvironment,requestJSON,signatureInputSnapshot} from '../cli/http.mjs';
import {publicError,ClientError} from '../cli/errors.mjs';

const version='0.4.7-diagnostic.1';
const usage='ai-commerce-diagnostic --version | doctor --signature-input | tools --diagnose-signature-input';

function syntheticCheck(){
 const keys=generateKeys(),release=generateKeyPairSync('rsa',{modulusLength:3072});
 const context=Buffer.from('offline-signature-input-fixture');
 const dek=randomBytes(32),now=Math.floor(Date.now()/1000);
 try{
  const state={access_token:'offline-fixture-only',expires_at:now+300,packet_id:'fixture',grant_id:'fixture',device_id:'fixture',family_id:'fixture',dek_generation:1,
   wrapping_context:b64(context),wrapped_dek:b64(publicEncrypt({key:keys.wrap_jwk,format:'jwk',oaepHash:'sha256',oaepLabel:context},dek))};
  const jwks={keys:[{...release.publicKey.export({format:'jwk'}),kid:'offline-fixture',alg:'RSA-OAEP-256',use:'enc'}]};
  const body=Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}');
  return signatureInputSnapshot(mcpRequest(keys,state,jwks,body,now).headers['signature-input']);
 }finally{dek.fill(0);}
}

// Standalone entrypoint from this checkout, intentionally not in the installer manifest.
export async function diagnosticMain(args=process.argv.slice(2),dependencies={}){
 const write=dependencies.write??(line=>process.stdout.write(line+'\n'));
 const emit=value=>write(JSON.stringify({version:1,...value}));
 try{
  // Native Node networking debug can write headers to stderr outside our formatter.
  if(process.env.NODE_DEBUG||process.env.NODE_DEBUG_NATIVE)throw new ClientError('unsafe_environment');
  assertEnvironment();
  if(args.length===1&&args[0]==='--version'){emit({ok:true,data:{version}});return 0;}
  if(args.length===1&&args[0]==='--help'){emit({ok:true,data:{usage}});return 0;}
  if(args.length===2&&args[0]==='doctor'&&args[1]==='--signature-input'){
   const signature_input=syntheticCheck();
   emit({ok:signature_input.expected_format,data:{runtime:{cli:version,node:process.versions.node},mode:'offline_synthetic',signature_input}});
   return signature_input.expected_format?0:1;
  }
  if(args.length===2&&args[0]==='tools'&&args[1]==='--diagnose-signature-input'){
   let trace={stage:'not_reached'};
   const transport=dependencies.transport??requestJSON;
   // The standard provider check sends one tools/list rather than paginating the catalogue.
   return await main(['session'],{...dependencies,
    updates:{check:()=>({status:'unavailable'})},
    transport:(url,options)=>transport(url,{...options,onSignatureInput:x=>{
     trace={stage:'before_send',present:x?.present===true,expected_format:x?.expected_format===true};
    }}),
    write:line=>{
     const message=JSON.parse(line);
     emit(message.ok===true?{ok:true,signature_input:trace}:{ok:false,error:message.error,signature_input:trace});
    },
   });
  }
  throw new ClientError('usage');
 }catch(error){emit({ok:false,error:publicError(error)});return 1;}
}

if(import.meta.main)process.exitCode=await diagnosticMain();
