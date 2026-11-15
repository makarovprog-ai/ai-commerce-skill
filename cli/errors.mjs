const codes = new Set(['usage','invalid_profile','invalid_request','invalid_target','unsafe_environment','unsafe_storage','storage_locked','storage_unavailable','secret_provider_unavailable','secret_provider_required','passphrase_required','login_required','cancelled','denied','failed','expired','completed','request_unavailable','network_error','invalid_response','command_failed','device_deactivated','sberid_check_in_progress','remote_error']);
const deactivatedMessage='Не удалось подтвердить вход через Сбер ID. Это устройство отключено. Войдите заново.';
function networkDetails(value) {
  const {operation,stage,elapsed_ms,cause}=value??{};
  if(['auth','mcp_metadata','mcp_request'].includes(operation)&&['request','response_body'].includes(stage)
    &&Number.isSafeInteger(elapsed_ms)&&elapsed_ms>=0&&['timeout','dns','connect','tls','reset','other'].includes(cause))return {operation,stage,elapsed_ms,cause};
}
export class ClientError extends Error {
  constructor(code,reason) { const safe = codes.has(code) ? code : 'command_failed'; super(safe); this.name = 'ClientError'; this.code = safe;
    if(safe==='login_required'&&['session_missing','refresh_outcome_unknown'].includes(reason))this.reason=reason;
    if(safe==='network_error')this.details=networkDetails(reason);
  }
}
export function publicError(error) {
  const code=error instanceof ClientError&&codes.has(error.code)?error.code:'command_failed';
  const reason=code==='login_required'&&['session_missing','refresh_outcome_unknown'].includes(error.reason)?error.reason:undefined;
  const details=code==='network_error'?networkDetails(error.details):undefined;
  return {code,...(details?{details}:{}),...(reason?{reason,next_action:'login'}:{}),...(code==='device_deactivated'?{message:deactivatedMessage,next_action:'login'}:{}),...(code==='secret_provider_unavailable'?{next_action:'Run doctor; check OS secure-store prerequisites and host script policy. Do not weaken execution policy. Use an approved inherited passphrase FD only when appropriate.'}:{})};
}
