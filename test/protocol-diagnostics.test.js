import test from 'node:test';
import assert from 'node:assert/strict';
import { NektoBrowser } from '../src/nekto.js';
import { describeProtocolMessage, sanitizeProtocolReport, updateProtocolSummary } from '../src/protocol-diagnostics.js';

test('native registration reports exact credential equality without exposing credentials', () => {
  const secret = '00000000-0000-4000-8000-000000000000';
  const report = describeProtocolMessage(JSON.stringify({ type: 'register', authToken: secret, privateField: 'fixture-private' }), secret, 'encrypt');
  assert.deepEqual(report, { direction: 'encrypt', type: 'register', credentialField: 'authToken', credentialMatches: true });
  assert.equal(describeProtocolMessage('{"type":"register","authToken":"old-fixture"}', secret, 'encrypt').credentialMatches, false);
  assert.equal(describeProtocolMessage('{"type":"register","userId":"fixture-token"}', 'fixture-token', 'encrypt').credentialField, 'userId');
  assert(!JSON.stringify(report).includes(secret));
  assert(!JSON.stringify(report).includes('fixture-private'));
});

test('search token absence, null and a supplied response remain distinct', () => {
  for (const [body, kind] of [[{}, 'missing'], [{ token: null }, 'null'], [{ token: '' }, 'empty'],
    [{ token: 'fixture-private-response' }, 'present'], [{ token: 1 }, 'other']]) {
    const report = describeProtocolMessage(JSON.stringify({ type: 'scan-for-peer', ...body }), 'fixture-token', 'encrypt');
    assert.equal(report.searchToken, kind);
    assert(!JSON.stringify(report).includes('fixture-private-response'));
  }
});

test('encrypted envelopes and unrelated plaintext are ignored; input is bounded', () => {
  for (const text of ['{"s":"cipher","i":"iv"}', '{"type":"message","text":"private"}', '{"type":"fixture-secret"}',
    'garbage', '2', 'x'.repeat(65537)]) assert.equal(describeProtocolMessage(text, 'fixture-token', 'encrypt'), null);
  assert.equal(describeProtocolMessage('{"type":"register"}', 'fixture-token', 'invalid'), null);
  assert.deepEqual(describeProtocolMessage('{"type":"registered","success":false}', '', 'decrypt'),
    { direction: 'decrypt', type: 'registered', success: 'false' });
});

test('untrusted page reports cannot log opaque strings or add credential contents', () => {
  const safe = sanitizeProtocolReport({ direction: 'encrypt', type: 'register',
    credentialField: 'fixture-secret', credentialMatches: 'fixture-secret', authToken: 'fixture-secret' });
  assert.deepEqual(safe, { direction: 'encrypt', type: 'register', credentialField: 'none', credentialMatches: false });
  assert.equal(sanitizeProtocolReport({ direction: 'decrypt', type: 'fixture-secret' }), null);
  assert.equal(sanitizeProtocolReport({ direction: 'decrypt', type: 'scan-for-peer', searchToken: 'fixture-secret' }).searchToken, 'other');
});

test('status summary separates observed input from server reply and challenge', () => {
  let summary = updateProtocolSummary(null, { direction: 'encrypt', type: 'register', credentialField: 'authToken', credentialMatches: true });
  assert.equal(summary.registrationPayloadObserved, true);
  assert.equal(summary.registrationReplyObserved, undefined);
  summary = updateProtocolSummary(summary, { direction: 'decrypt', type: 'registered', success: 'true' });
  summary = updateProtocolSummary(summary, { direction: 'encrypt', type: 'scan-for-peer', searchToken: 'null' });
  summary = updateProtocolSummary(summary, { direction: 'decrypt', type: 'captcha-request' });
  assert.deepEqual(summary, { registrationPayloadObserved: true, credentialField: 'authToken', credentialMatches: true,
    registrationReplyObserved: true, registrationSuccess: 'true', searchToken: 'null', captchaRequested: true });
});

test('stopping or replacing a session clears its credential observations', async () => {
  const browser = new NektoBrowser(() => {});
  browser.protocolDiagnostics = { registrationPayloadObserved: true, credentialMatches: true };
  await browser.stop();
  assert.equal(browser.protocolDiagnostics, null);
});
