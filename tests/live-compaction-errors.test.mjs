import test from 'node:test';
import assert from 'node:assert/strict';
import {DevicApiError} from '../dist/errors.js';
import {compactionNotFound} from '../dist/live/failures.js';

test('compaction distinguishes a missing route from a missing or inaccessible chat', () => {
  const route = compactionNotFound(new DevicApiError({statusCode:404,message:'Cannot POST /api/v1/assistants/test/chats/uid/compact'}));
  assert.match(route,/does not expose the compaction endpoint/);
  const chat = compactionNotFound(new DevicApiError({statusCode:404,message:'Chat not found'}));
  assert.match(chat,/Chat not found/); assert.match(chat,/account\/user scope/);
  assert.doesNotMatch(chat,/updated backend|does not expose/);
  const other = compactionNotFound(new DevicApiError({statusCode:404,message:'Provider model not found'}));
  assert.match(other,/Provider model not found/); assert.doesNotMatch(other,/updated backend/);
  assert.equal(compactionNotFound(new DevicApiError({statusCode:409,message:'Conversation is busy'})),undefined);
  assert.equal(compactionNotFound(new Error('Network error')),undefined);
});
