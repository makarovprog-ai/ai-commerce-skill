const codes = new Set(['usage','invalid_profile','invalid_request','invalid_target','unsafe_environment','unsafe_storage','storage_locked','storage_unavailable','secret_provider_unavailable','secret_provider_required','passphrase_required','login_required','cancelled','denied','failed','expired','completed','request_unavailable','network_error','invalid_response','command_failed']);
export class ClientError extends Error {
  constructor(code) { const safe = codes.has(code) ? code : 'command_failed'; super(safe); this.name = 'ClientError'; this.code = safe; }
}
export function publicError(error) {
  const code=error instanceof ClientError&&codes.has(error.code)?error.code:'command_failed';
  return {code,...(code==='secret_provider_unavailable'?{next_action:'Run doctor; check OS secure-store prerequisites and host script policy. Do not weaken execution policy. Use an approved inherited passphrase FD only when appropriate.'}:{})};
}
