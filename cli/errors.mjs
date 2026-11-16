const codes = new Set(['usage','invalid_profile','invalid_request','invalid_target','unsafe_environment','unsafe_storage','storage_locked','storage_unavailable','secret_provider_unavailable','secret_provider_required','passphrase_required','login_required','cancelled','denied','failed','expired','completed','request_unavailable','network_error','invalid_response','command_failed','device_deactivated','sberid_check_in_progress','remote_error']);
const deactivatedMessage='Не удалось подтвердить вход через Сбер ID. Это устройство отключено. Войдите заново.';
const phases=new Set(['local-session','refresh','token','jwks','mcp-session','session','release-jwks','tools/list','tools/call','mcp','network-probe','enrollment']);
export const safeRequestId=value=>typeof value==='string'&&/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value)?value:undefined;
function safeDiagnostics(value) {
  const {phase,time_utc,http_status,elapsed_ms,request_id,cause}=value??{};
  const id=safeRequestId(request_id);
  const result={
    ...(phases.has(phase)?{phase}:{}),
    ...(typeof time_utc==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(time_utc)?{time_utc}:{}),
    ...(Number.isInteger(http_status)&&http_status>=100&&http_status<=599?{http_status}:{}),
    ...(Number.isSafeInteger(elapsed_ms)&&elapsed_ms>=0?{elapsed_ms}:{}),
    ...(id?{request_id:id}:{}),
    ...(['network_error','invalid_response','remote_error','command_failed'].includes(cause)?{cause}:{}),
  };
  return Object.keys(result).length?result:undefined;
}
export function diagnosticError(error,phase) {
  if(error instanceof ClientError)error.diagnostics=safeDiagnostics({time_utc:new Date().toISOString(),elapsed_ms:error.details?.elapsed_ms,...error.diagnostics,phase});
  return error;
}
export function httpError(code,response,phase) {
  return diagnosticError(new ClientError(code,undefined,{http_status:response.status,request_id:response.requestId,elapsed_ms:response.elapsedMs}),phase);
}
function networkDetails(value) {
  const {operation,stage,elapsed_ms,cause}=value??{};
  if(['auth','mcp_metadata','mcp_request'].includes(operation)&&['request','response_body'].includes(stage)
    &&Number.isSafeInteger(elapsed_ms)&&elapsed_ms>=0&&['timeout','dns','connect','tls','reset','other'].includes(cause))return {operation,stage,elapsed_ms,cause};
}
export class ClientError extends Error {
  constructor(code,reason,diagnostics) { const safe = codes.has(code) ? code : 'command_failed'; super(safe); this.name = 'ClientError'; this.code = safe;
    if(safe==='login_required'&&['session_missing','refresh_outcome_unknown'].includes(reason))this.reason=reason;
    if(safe==='network_error')this.details=networkDetails(reason);
    if(diagnostics)this.diagnostics=safeDiagnostics(diagnostics);
  }
}
export function publicError(error) {
  const code=error instanceof ClientError&&codes.has(error.code)?error.code:'command_failed';
  const reason=code==='login_required'&&['session_missing','refresh_outcome_unknown'].includes(error.reason)?error.reason:undefined;
  const details=code==='network_error'?networkDetails(error.details):undefined;
  const diagnostics=error instanceof ClientError?safeDiagnostics(error.diagnostics):undefined;
  return {code,...(details?{details}:{}),...(diagnostics?{diagnostics}:{}),...(reason?{reason,next_action:'login'}:{}),...(code==='device_deactivated'?{message:deactivatedMessage,next_action:'login'}:{}),...(code==='secret_provider_unavailable'?{next_action:'Run doctor; check OS secure-store prerequisites and host script policy. Do not weaken execution policy. Use an approved inherited passphrase FD only when appropriate.'}:{})};
}
