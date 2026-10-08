import test from 'node:test';
import assert from 'node:assert/strict';
import { statusReply } from '../src/status-reply.js';

const args = { voice: 'ready', queue: { received: 0, nonSilent: 0 },
  status: { active: true, callState: { phase: 'searching for a partner' }, authorization: 'native-session-confirmed', peers: 0 } };

test('private status shows the complete saved token and accurate partner state', () => {
  const reply = statusReply({ ...args, token: 'full-test-token-1234567890' });
  assert(reply.content.includes('Token: full-test-token-1234567890'));
  assert(reply.content.includes('Nekto: searching for a partner'));
  assert(reply.content.includes('captured tracks=0'));
  assert.deepEqual(reply.allowedMentions, { parse: [] });
});

test('long tokens are preserved in an attachment within Discord message limits', () => {
  const token = 'complete-token-'.repeat(300);
  const reply = statusReply({ ...args, token });
  assert(reply.content.length <= 2000);
  assert.equal(reply.files[0].attachment.toString('utf8'), token);
  assert.equal(reply.files[0].name, 'nekto-token.txt');
});
