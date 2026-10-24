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
