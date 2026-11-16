import {setTimeout as delay} from 'node:timers/promises';
import {BASE,REDIRECT,profile,b64,decode,random,hash,sign,unwrap,dpop,verifyToken,mcpRequest} from './crypto.mjs';
import {Storage,defaultDirectory} from './storage.mjs';
import {join} from 'node:path';
import {ClientError,publicError,diagnosticError,httpError} from './errors.mjs';
import {requestJSON,assertEnvironment} from './http.mjs';
import {discoverTools,validateCompleteTools,mcpPhase} from './tool-discovery.mjs';
import {inspectSecretProvider} from './secret-store.mjs';
const require=(value)=>{if(!value)throw new ClientError('invalid_response');};
const opaque=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const fields=(o,names,check=require)=>{check(o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===names.length&&names.every(n=>Object.hasOwn(o,n)));};
const enrollmentError=(response,reason)=>httpError('invalid_response',response,'enrollment',reason);
const enrollmentCheck=response=>(value,reason='invalid_enrollment_format')=>{if(!value)throw enrollmentError(response,reason);};
const terminal=new Set(['denied','failed','expired','completed','request_unavailable']);
const metadataBody=()=>Buffer.from(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}}));
// Called only for HTTP responses from the fixed Auth/MCP transport targets.
// Never inspect successful business payloads or use remote message text.
function serviceError(response,field,phase){
  const code=response.data?.[field];
  if(response.status===401&&code==='device_deactivated')throw httpError(code,response,phase);
  if(response.status===503&&code==='sberid_check_in_progress')throw httpError(code,response,phase);
}
// A remote tool must not be able to reflect local custody material into output.
function publicMcpResponse(response,state){
  const secrets=['access_token','refresh_token','wrapped_dek','wrapping_context'].map(name=>state[name]).filter(value=>typeof value==='string'&&value.length);
  let serialized=JSON.stringify(response.data);for(const secret of secrets)serialized=serialized.split(secret).join('[redacted]');
  return {...response,data:JSON.parse(serialized)};
}
export class CommerceClient{
  constructor({directory,profile:profileName='mcp',store,transport=requestJSON,sleep=delay,now=()=>Math.floor(Date.now()/1000),output=()=>{},signal,storageOptions}={}) {
    this.profile=profile(profileName);this.directory=directory??join(defaultDirectory(),profileName);this.storageOptions=storageOptions??{};this.store=store??new Storage(this.directory,profileName,storageOptions);this.transport=transport;this.sleep=sleep;this.now=now;this.output=output;this.signal=signal;
  }
  check(){assertEnvironment();if(this.signal?.aborted)throw new ClientError('cancelled');}
  async request(path,keys,method='GET',body,accessToken,phase=path.startsWith('/device/')?'enrollment':path.slice(1)){
    this.check();const url=BASE+path;
    try{
      const response=await this.transport(url,{method,signal:this.signal,headers:{...(keys?{DPoP:dpop(keys,method,url,accessToken,this.now())}:{}),...(body?{'content-type':typeof body==='string'?'application/x-www-form-urlencoded':'application/json'}:{}),...(accessToken?{authorization:`DPoP ${accessToken}`}:{})},body:body?typeof body==='string'?body:JSON.stringify(body):undefined});
      this.check();serviceError(response,'code',phase);return response;
    }catch(error){throw diagnosticError(error,phase);}
  }
  async withCustody(callback,options){
    return this.store.withLock(async store=>{
      try{return await callback(store);}
      catch(error){
        if(error instanceof ClientError&&error.code==='device_deactivated'&&store){
          const keys=await store.keys(false);if(keys)await store.block(keys);
        }
        throw error;
      }
    },options);
  }
  async pause(seconds){this.check();try{await this.sleep(seconds*1000,undefined,{signal:this.signal});}catch(e){this.check();throw e;}this.check();}
  async login() {
    return this.withCustody(async store=>{
      this.check();
      const keys=await store.keys(true);
      // Validate custody before any signed transport. Authentic expired state or
      // an in-flight marker permits explicit new login, never old-RT reuse.
      await store.session(keys);
      await store.blocked(keys);
      const state=random();
      const verifier=random();
      const challenge=hash(verifier);
      const enrollment={
        client_id:this.profile.client,redirect_uri:REDIRECT,state,code_challenge:challenge,
        code_challenge_method:'S256',sign_jwk:keys.sign_jwk,wrap_jwk:keys.wrap_jwk,
      };
      const created=await this.request('/device/requests',keys,'POST',enrollment);
      // The server issues the challenge during the request, not before outbound transit.
      const receivedAt=this.now();
      const checkCreated=enrollmentCheck(created);
      checkCreated(created.status===201,'unexpected_http_status');
      const c=created.data;
      fields(c,['request_id','signing_input','wrapping_challenge','wrapping_label','expires_at','proof_expires_at'],checkCreated);
      checkCreated(opaque(c.request_id) && Number.isInteger(c.expires_at) && Number.isInteger(c.proof_expires_at));
      checkCreated(c.expires_at>receivedAt && c.proof_expires_at>receivedAt,'enrollment_expired');
      checkCreated(c.expires_at<=receivedAt+605 && c.proof_expires_at<=receivedAt+125
        && c.proof_expires_at<=c.expires_at,'enrollment_time_out_of_bounds');

      let transcript;
      try{transcript=decode(c.signing_input);}catch{throw enrollmentError(created,'invalid_enrollment_format');}
      const lines=transcript.toString('utf8').split('\n');
      checkCreated(opaque(lines[2]));
      const expected=[
        'auth-sberid-cross-device-enrollment-v1',c.request_id,lines[2],keys.signJkt,
        keys.wrapJkt,this.profile.client,REDIRECT,state,challenge,'S256',this.profile.scope,String(c.expires_at),
      ].join('\n');
      checkCreated(transcript.equals(Buffer.from(expected)) && c.wrapping_label===b64(transcript),'enrollment_binding_mismatch');
      let raw;
      try{raw=unwrap(keys,c.wrapping_challenge,transcript);}catch{throw enrollmentError(created,'enrollment_key_unwrap_failed');}
      let proof;
      try {
        checkCreated(raw.length===32,'enrollment_key_unwrap_failed');
        proof={signing_proof:sign(keys,transcript),wrapping_proof:b64(raw)};
      } finally {
        raw.fill(0);
      }
      const proved=await this.request(`/device/requests/${c.request_id}/prove`,keys,'POST',proof);
      const checkProved=enrollmentCheck(proved);
      checkProved(proved.status===200,'unexpected_http_status');
      const p=proved.data;
      fields(p,['status','verification_uri','user_code','expires_at','interval'],checkProved);
      checkProved(p.status==='pending' && /^[0-9A-HJKMNP-TV-Z]{4}$/.test(p.user_code) && p.interval===5);
      checkProved(p.verification_uri===`${BASE}/device/${c.request_id}` && p.expires_at===c.expires_at,'enrollment_binding_mismatch');
      this.output({verification_uri:p.verification_uri,user_code:p.user_code});

      let interval=5;
      let ready;
      while(this.now()<c.expires_at) {
        await this.pause(interval);
        if(this.now()>=c.expires_at)break;
        let polled;
        try {
          polled=await this.request(`/device/requests/${c.request_id}/result`,keys);
        } catch(error) {
          if(error.code!=='network_error')throw error;
          interval=Math.min(30,interval+5);
          continue;
        }
        if(polled.status===410) {
          throw new ClientError(terminal.has(polled.data?.code)?polled.data.code:'request_unavailable');
        }
        if(polled.status===429 && polled.data?.code==='slow_down') {
          const retry=Number(polled.retryAfter);
          require(Number.isInteger(retry) && retry>=5 && retry<=30);
          interval=Math.min(30,Math.max(interval+5,retry));
          continue;
        }
        if(polled.status===202) {
          fields(polled.data,['status','expires_at','interval']);
          require(polled.data.status==='pending' && polled.data.expires_at===c.expires_at
            && Number.isInteger(polled.data.interval) && polled.data.interval>=5 && polled.data.interval<=30);
          interval=Math.max(interval,polled.data.interval);
          continue;
        }
        require(polled.status===200);
        ready=polled.data;
        break;
      }
      if(!ready)throw new ClientError('expired');
      fields(ready,['status','client_id','redirect_uri','state','code','code_expires_at']);
      require(ready.status==='ready' && ready.client_id===this.profile.client && ready.redirect_uri===REDIRECT
        && ready.state===state && opaque(ready.code) && Number.isInteger(ready.code_expires_at)
        && ready.code_expires_at>this.now() && ready.code_expires_at<=Math.min(c.expires_at,this.now()+65));

      // Redemption is one-use: every ambiguous response requires explicit fresh login.
      let token;
      try {
        token=await this.request('/token',keys,'POST',new URLSearchParams({
          grant_type:'authorization_code',client_id:this.profile.client,redirect_uri:REDIRECT,
          code:ready.code,code_verifier:verifier,
        }).toString());
      } catch(error) {
        if(error instanceof ClientError&&['device_deactivated','sberid_check_in_progress'].includes(error.code))throw error;
        throw diagnosticError(new ClientError('login_required',undefined,{
          ...(error instanceof ClientError?error.diagnostics:undefined),cause:error instanceof ClientError?error.code:'command_failed',
        }),'token');
      }
      if(token.status!==200)throw httpError('login_required',token,'token');
      const session=await this.validate(token.data,keys);
      await store.save(keys,session);
      const result=await this.protectedSession(keys,session,store);
      await store.clearBlock(keys);return result;
    });
  }

  async validate(t,keys) {
    fields(t,['token_type','expires_in','access_token','refresh_token','scope','user_id',
      'device_id','grant_id','existing_user','packet_id','wrapped_dek','wrapping_context','dek_generation']);
    require(t.token_type==='DPoP' && t.scope===this.profile.scope && t.expires_in===300
      && opaque(t.refresh_token) && typeof t.existing_user==='boolean'
      && ['user_id','device_id','grant_id','packet_id'].every(k=>uuid(t[k])) && t.dek_generation===1);

    const jwks=await this.request('/jwks');
    if(jwks.status!==200)throw httpError('invalid_response',jwks,'jwks');
    const claims=await verifyToken(t.access_token,jwks.data,keys,t,this.now(),this.profile);
    require(uuid(claims.family_id));
    const context=decode(t.wrapping_context).toString('utf8');
    const lines=context.split('\n');
    require(lines.length===7 && lines[0]==='auth-sberid-v1'
      && lines[1]===`packet_id=${t.packet_id}` && lines[2]===`user_id=${t.user_id}`
      && lines[3]===`device_id=${t.device_id}` && /^environment=[A-Za-z0-9_-]{1,32}$/.test(lines[4])
      && lines[5]===`wrap_jkt=${keys.wrapJkt}` && lines[6]==='dek_generation=1');
    const dek=unwrap(keys,t.wrapped_dek,Buffer.from(context));
    try {
      require(dek.length===32);
    } finally {
      dek.fill(0);
    }
    return {
      version:1,client_id:this.profile.client,sign_jkt:keys.signJkt,wrap_jkt:keys.wrapJkt,
      access_token:t.access_token,refresh_token:t.refresh_token,expires_at:claims.exp,
      user_id:t.user_id,device_id:t.device_id,grant_id:t.grant_id,rotation_in_flight:false,
      ...(this.profile.scope==='mcp:invoke'?{family_id:claims.family_id,packet_id:t.packet_id,wrapped_dek:t.wrapped_dek,wrapping_context:t.wrapping_context,dek_generation:t.dek_generation}:{}),
    };
  }

  async load(store) {
    const keys=await store?.keys(false);
    if(!keys)throw diagnosticError(new ClientError('login_required','session_missing'),'local-session');
    if(await store.blocked(keys))throw new ClientError('device_deactivated');
    const state=await store.session(keys);
    if(!state)throw diagnosticError(new ClientError('login_required','session_missing'),'local-session');
    if(state.rotation_in_flight)throw diagnosticError(new ClientError('login_required','refresh_outcome_unknown'),'local-session');
    require(state.version===1 && state.client_id===this.profile.client && state.sign_jkt===keys.signJkt
      && state.wrap_jkt===keys.wrapJkt && opaque(state.refresh_token));
    return {keys,state};
  }
  async protectedSession(keys,state,store){
    const mcp=this.profile.scope==='mcp:invoke';
    const phase=mcp?'mcp-session':'session';
    const r=await this.request('/'+phase,keys,'GET',undefined,state.access_token);
    if(r.status!==200)throw httpError('invalid_response',r,phase);
    const bindings=['user_id','device_id','grant_id',...(mcp?['family_id','packet_id','wrapped_dek','wrapping_context','dek_generation']:[])];
    try{
      fields(r.data,['status',...bindings]);
      require(r.data.status==='active'&&bindings.every(k=>r.data[k]===state[k]));
    }catch(error){if(error instanceof ClientError)throw httpError(error.code,r,phase);throw error;}
    if(mcp&&store)await store.save(keys,state);
    return {status:'active',provider_check:'not_checked',user_id:state.user_id,device_id:state.device_id,grant_id:state.grant_id};
  }
  async rotate(store,keys,state){
    await store.save(keys,{...state,rotation_in_flight:true});
    let tokenReceived=false;
    try{
      const r=await this.request('/token',keys,'POST',new URLSearchParams({grant_type:'refresh_token',client_id:this.profile.client,refresh_token:state.refresh_token}).toString(),undefined,'refresh');
      tokenReceived=true;
      if(r.status!==200)throw httpError('remote_error',r,'refresh');
      const next=await this.validate(r.data,keys);
      require(['user_id','device_id','grant_id',...(this.profile.scope==='mcp:invoke'?['family_id','packet_id','wrapped_dek','wrapping_context','dek_generation']:[])].every(k=>next[k]===state[k]));
      await store.save(keys,next);return next;
    }catch(error){
      if(error instanceof ClientError&&error.code==='device_deactivated')throw error;
      if(error instanceof ClientError&&error.code==='sberid_check_in_progress'){
        // A definitive pre-rotation busy response is not an ambiguous rotation.
        // A failure during later JWT validation must retain the one-use marker.
        if(!tokenReceived)await store.save(keys,state);
        throw error;
      }
      const cause=error instanceof ClientError?error.code:'command_failed';
      throw new ClientError('login_required','refresh_outcome_unknown',{
        time_utc:new Date().toISOString(),elapsed_ms:error instanceof ClientError?error.details?.elapsed_ms:undefined,
        ...(error instanceof ClientError?error.diagnostics:undefined),phase:'refresh',cause,
      });
    }
  }
  async releaseJwks(){
    const jwks=await this.request('/release-jwks');if(jwks.status!==200)throw httpError('invalid_response',jwks,'release-jwks');this.check();
    return jwks.data;
  }
  async sendMcp(keys,state,body,jwks,maxResponseBytes){
    this.check();
    try{
      const request=mcpRequest(keys,state,jwks,body,this.now());
      const response=await this.transport(this.profile.audience,{...request,signal:this.signal,...(maxResponseBytes===undefined?{}:{maxResponseBytes})});this.check();
      if(response.status===401||response.status===503)serviceError(response,'error',mcpPhase(body));
      return response;
    }catch(error){throw diagnosticError(error,mcpPhase(body));}
  }
  async checkedSession(keys,state,store){
    const result=await this.protectedSession(keys,state,store);
    if(this.profile.scope!=='mcp:invoke')return result;
    const response=await this.sendMcp(keys,state,metadataBody(),await this.releaseJwks());
    if(response.status!==200)throw httpError('remote_error',response,'tools/list');
    return {...result,provider_check:'verified'};
  }
  // Keep the existing early-rotation margin for the Auth and provider path.
  // This is an early rotation, never an automatic retry of a failed request.
  async session(){return this.withCustody(async store=>{let {keys,state}=await this.load(store);if(state.expires_at<=this.now()+90)state=await this.rotate(store,keys,state);return this.checkedSession(keys,state,store);},{create:false});}
  async refresh(){return this.withCustody(async store=>{const {keys,state}=await this.load(store);return this.checkedSession(keys,await this.rotate(store,keys,state),store);},{create:false});}
  async withMcpPreflight(callback){
    require(this.profile.scope==='mcp:invoke');
    return this.withCustody(async store=>{
      let {keys,state}=await this.load(store);
      if(state.expires_at<=this.now()+90)state=await this.rotate(store,keys,state);
      await this.protectedSession(keys,state,store);
      return callback(keys,state,await this.releaseJwks());
    },{create:false});
  }
  async mcp(body){
    require(Buffer.isBuffer(body)&&body.length<=262144);
    return this.withMcpPreflight(async(keys,state,jwks)=>publicMcpResponse(await this.sendMcp(keys,state,body,jwks),state));
  }
  async logout(){this.check();return this.store.withLock(async store=>{await store?.logout();return {status:'signed_out'};},{create:false});}
  async doctor(){this.check();return {runtime:{node:process.versions.node,supported:Number(process.versions.node.split('.')[0])===24},profile:this.profile.scope==='mcp:invoke'?'mcp':'diagnostic',storage:await inspectSecretProvider({...this.storageOptions,directory:this.directory}),network:'not_checked'};}
  async tools(){
    return this.withMcpPreflight(async(keys,state,jwks)=>{
      const response=await discoverTools((body,remaining)=>this.sendMcp(keys,state,body,jwks,remaining));
      let safe;try{safe=publicMcpResponse(response,state);}catch{throw new ClientError('invalid_response');}
      validateCompleteTools(safe.data);
      return safe;
    });
  }
  async status(){this.check();return this.store.withLock(async store=>{if(!store)return {status:'signed_out'};const keys=await store.keys(false);if(!keys)return {status:'signed_out'};if(await store.blocked(keys)){const {code,...action}=publicError(new ClientError('device_deactivated'));return {status:code,...action};}const s=await store.session(keys);if(!s)return {status:'signed_out'};return {status:s.rotation_in_flight?'login_required':s.expires_at<=this.now()?'expired':'stored',...(s.rotation_in_flight?{reason:'refresh_outcome_unknown',next_action:'login'}:{user_id:s.user_id,device_id:s.device_id,grant_id:s.grant_id})};},{create:false});}
}
