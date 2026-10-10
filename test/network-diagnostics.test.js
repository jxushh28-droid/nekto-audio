import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyNektoRequest, describeNativeFlag, describeSocketFrame, sanitizeVerificationReport, attachNektoDiagnostics } from '../src/network-diagnostics.js';

test('resource classification checks exact hosts and CAPTCHA paths without returning URLs', () => {
  assert.equal(classifyNektoRequest('https://nekto-me.kz/audiochat#/'), 'site');
  assert.equal(classifyNektoRequest('wss://audio.nekto-me.kz/socket?token=fixture-secret'), 'audio');
  assert.equal(classifyNektoRequest('https://www.google.com/recaptcha/api.js?secret=fixture-secret'), 'captcha');
  assert.equal(classifyNektoRequest('https://www.gstatic.com/recaptcha/releases/test.js'), 'captcha');
  assert.equal(classifyNektoRequest('https://newassets.hcaptcha.com/captcha.js'), 'captcha');
  for (const url of ['https://evil-nekto-me.kz/', 'https://audio.nekto-me.kz.evil.invalid/', 'https://www.google.com/other', 'file:///nekto-me.kz', 'not a URL']) {
    assert.equal(classifyNektoRequest(url), null);
  }
});

test('socket trace reports token equality and event categories, never message contents', () => {
  const token = '00000000-0000-4000-8000-000000000000';
  const payload = { event: 'user/register', data: { authToken: token, peer: 'fixture-private-peer', sdp: 'fixture-private-sdp', text: 'fixture-private-chat' } };
  const report = describeSocketFrame(JSON.stringify(payload), token);
  assert.deepEqual(report, { category: 'authorization', tokenFieldPresent: true, configuredTokenPresent: true });
  assert.equal(describeSocketFrame('42/audio,12["register",{"authToken":"' + token + '"}]', token).configuredTokenPresent, true);
  assert.equal(describeSocketFrame(JSON.stringify({ event: 'register', data: JSON.stringify(payload.data) }), token).configuredTokenPresent, true);
  assert.equal(describeSocketFrame('42["search",{"authToken":"different-token"}]', token).configuredTokenPresent, false);
  assert.equal(describeSocketFrame('42["search",{"authToken":"different-token"}]', token).category, 'search');
  assert.equal(describeSocketFrame(JSON.stringify({ event: 'socket_captcha', captchaRequired: 'false' }), token).captcharequired.value, 'false');
  assert.equal(describeSocketFrame(JSON.stringify({ event: token, tokenId: 7 }), token).category, 'other');
  for (const secret of [token, 'fixture-private-peer', 'fixture-private-sdp', 'fixture-private-chat']) assert(!JSON.stringify(report).includes(secret));
  for (const invalid of ['garbage', '2', 'x'.repeat(131073), new Uint8Array([1, 2])]) assert.equal(describeSocketFrame(invalid, token), null);
});

test('flag diagnostics preserve false-like strings without treating them as booleans', () => {
  assert.deepEqual(describeNativeFlag('false'), { type: 'string', value: 'false' });
  assert.deepEqual(describeNativeFlag(false), { type: 'boolean', value: false });
  assert.deepEqual(describeNativeFlag('0'), { type: 'string', value: '0' });
  assert.deepEqual(describeNativeFlag(undefined), { type: 'undefined' });
  assert.deepEqual(describeNativeFlag('fixture-secret'), { type: 'string', value: '[other string]' });
  assert.deepEqual(describeNativeFlag({ authToken: 'fixture-secret' }), { type: 'object' });
});

test('browser reports cannot inject arbitrary state or credential values into logs', () => {
  const safe = sanitizeVerificationReport({ mutation: 'fixture-secret', captcha: { type: 'string', value: 'fixture-secret' },
    hcaptcha: { type: 'boolean', value: false }, recaptchaApi: 'fixture-secret', challengeFrames: 100,
    authToken: 'fixture-secret' });
  assert.equal(safe.mutation, 'other');
  assert.deepEqual(safe.captcha, { type: 'unknown' });
  assert.equal(safe.challengeFrames, 20);
  assert(!JSON.stringify(safe).includes('fixture-secret'));
  assert.equal(sanitizeVerificationReport({ mutation: 'system/socket_captcha.required' }).mutation, 'system/socket_captcha.required');
});

test('page diagnostics exclude URL queries, raw socket messages and stale-session events', async () => {
  const listeners = {}, socketListeners = {}, reports = [];
  let current = true, binding;
  const main = { url: () => 'https://nekto-me.kz/audiochat#/' };
  const page = {
    on: (name, callback) => { listeners[name] = callback; },
    mainFrame: () => main,
    exposeBinding: async (_, callback) => { binding = callback; },
    addInitScript: async () => {},
  };
  await attachNektoDiagnostics(page, 'fixture-secret', { current: () => current, log: report => reports.push(report) });
  listeners.response({ url: () => 'https://audio.nekto-me.kz/?authToken=fixture-secret', status: () => 403 });
  listeners.requestfailed({ url: () => 'https://www.google.com/recaptcha/api.js', failure: () => ({ errorText: 'net::ERR_FAILED fixture-secret' }) });
  listeners.websocket({ url: () => 'wss://audio.nekto-me.kz/?token=fixture-secret', on: (name, cb) => { socketListeners[name] = cb; } });
  socketListeners.framesent({ payload: '{"event":"register","authToken":"fixture-secret","sdp":"private-sdp"}' });
  assert.equal(reports.find(report => report.event === 'nekto_socket_trace').configuredTokenPresent, true);
  assert(!JSON.stringify(reports).includes('fixture-secret'));
  assert(!JSON.stringify(reports).includes('private-sdp'));
  assert.equal(reports.find(report => report.event === 'nekto_request_failed').code, 'request-failed');
  const before = reports.length;
  binding({ frame: { url: () => 'https://nekto-me.kz/' } }, {});
  assert.equal(reports.length, before);
  current = false;
  listeners.response({ url: () => 'https://audio.nekto-me.kz/', status: () => 500 });
  socketListeners.close();
  binding({ frame: main }, {});
  assert.equal(reports.length, before);
});
