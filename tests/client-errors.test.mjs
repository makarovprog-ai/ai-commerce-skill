import test from 'node:test';
import assert from 'node:assert/strict';
import {ClientError,publicError} from '../cli/errors.mjs';
test('errors expose fixed codes and never supplied secret messages',()=>{
 const secret='sensitive-token-value';
 assert.equal(new ClientError('network_error',secret).message,'network_error');
 assert.deepEqual(publicError(new Error(secret)),{code:'command_failed'});
 assert.deepEqual(publicError(new ClientError('network_error')),{code:'network_error'});
 assert.deepEqual(publicError({code:secret}),{code:'command_failed'});
});
test('login reasons are allowlisted and do not expose arbitrary remote errors',()=>{
 assert.deepEqual(publicError(new ClientError('login_required','session_missing')),{code:'login_required',reason:'session_missing',next_action:'check_session_context'});
 assert.deepEqual(publicError(new ClientError('login_required','refresh_outcome_unknown')),{code:'login_required',reason:'refresh_outcome_unknown',next_action:'login'});
 assert.deepEqual(publicError(new ClientError('login_required','secret-bank-response')),{code:'login_required'});
 assert.deepEqual(publicError(new ClientError('network_error','session_missing')),{code:'network_error'});
});
