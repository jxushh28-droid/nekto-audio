import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { audioClientReady, authorizeAudioToken, audioTokenMatches, authorizationError } from '../src/live-session.js';

function fixture({ response = 'accepted', chat = false, initial = 'old-token', source = 'app' } = {}) {
  const storage = new Map([['storage_audio_v2', JSON.stringify({ user: { authToken: 'new-token' } })]]);
  const subscribers = new Set(), commits = [];
  let calls = 0;
  const state = { user: { authToken: initial }, system: { socketConnected: true, isAuth: true } };
  if (chat) state.chat = {};
  const store = {
    state, _mutations: { 'user/setAuthToken': [() => {}] },
    commit(type, token) { commits.push(type); state.user.authToken = token; },
    subscribe(callback) { subscribers.add(callback); return () => subscribers.delete(callback); },
  };
  const emit = type => subscribers.forEach(callback => callback({ type }));
  const actions = { authorize() {
    calls++;
    if (response === 'throw') throw new Error('secret-new-token');
    if (response === 'reject') return Promise.reject(new Error('secret-new-token'));
    if (response === 'timeout') return;
    if (response === 'verification') { state.system.captchaRequired = true; emit('system/setCaptchaRequired'); return; }
    if (response === 'replaced') state.user.authToken = 'server-token';
    if (response === 'storage') storage.set('storage_audio_v2', '{}');
    state.user.tokenModel = { tokenInfo: { authToken: state.user.authToken } };
    emit('user/socket_auth.successToken');
    // Persistence can run AFTER the bot's subscriber in the same mutation.
    if (response !== 'storage') storage.set('storage_audio_v2', JSON.stringify({ user: { authToken: state.user.authToken } }));
  } };
  const app = { $store: store };
  if (source === 'store') store.$socketActions = actions; else app.$socketActions = actions;
  const context = vm.createContext({
    document: { querySelectorAll: () => [{ __vue__: { $store: { state: { user: {} } } } }, { __vue__: app }] },
    localStorage: { getItem: key => storage.get(key) }, setTimeout, clearTimeout,
  });
  const run = (fn, args) => vm.runInContext(`(${fn.toString()})(${JSON.stringify(args)})`, context);
  return { run, state, store, subscribers, commits, storage, calls: () => calls };
}

test('live Vuex authorization uses audio storage and accepts a server success mutation', async () => {
  for (const options of [{ chat: true }, { chat: false, source: 'store' }]) {
    const f = fixture(options);
    assert.equal(f.run(audioClientReady), true);
    const result = await f.run(authorizeAudioToken, { token: 'new-token', timeout: 100 });
    assert.equal(result.ok, true); assert.equal(result.reason, 'accepted');
    assert.deepEqual(f.commits, ['user/setAuthToken']); assert.equal(f.calls(), 1);
    assert.equal(f.state.user.authToken, 'new-token'); assert.equal(f.subscribers.size, 0);
    assert.equal(f.run(audioTokenMatches, 'new-token').ok, true);
    assert(!JSON.stringify(result).includes('new-token'));
  }
});

test('matching local storage and Vuex alone do not count as server acceptance', async () => {
  const f = fixture({ response: 'timeout', initial: 'new-token' });
  const result = await f.run(authorizeAudioToken, { token: 'new-token', timeout: 10 });
  assert.equal(result.ok, false); assert.equal(result.reason, 'authorization-timeout');
  assert.equal(f.calls(), 1); assert.equal(f.subscribers.size, 0);
});

test('authorization stops on replacement, verification, storage mismatch and client errors', async () => {
  for (const [response, reason] of [['replaced', 'token-replaced'], ['verification', 'verification-required'],
    ['storage', 'storage-mismatch'], ['throw', 'authorization-failed'], ['reject', 'authorization-failed']]) {
    const f = fixture({ response });
    const result = await f.run(authorizeAudioToken, { token: 'new-token', timeout: 100 });
    assert.equal(result.ok, false); assert.equal(result.reason, reason); assert.equal(f.subscribers.size, 0);
    assert(!JSON.stringify(result).includes('secret-new-token'));
  }
});

test('redundant authorization may retain a previously confirmed server identity', async () => {
  const f = fixture({ response: 'timeout', initial: 'new-token' });
  f.state.user.tokenModel = { tokenInfo: { authToken: 'new-token' } };
  const result = await f.run(authorizeAudioToken, { token: 'new-token', timeout: 100, settle: 5 });
  assert.equal(result.ok, true); assert.equal(result.reason, 'existing-session-confirmed');
  assert.equal(result.responseReceived, false); assert.equal(f.calls(), 1); assert.equal(f.subscribers.size, 0);
});

test('existing verification and missing mutation prevent authorization', async () => {
  const f = fixture();
  f.state.system.hcaptchaRequired = true;
  assert.equal((await f.run(authorizeAudioToken, { token: 'new-token' })).reason, 'verification-required');
  f.state.system.hcaptchaRequired = false; f.store._mutations = {};
  assert.equal((await f.run(authorizeAudioToken, { token: 'new-token' })).reason, 'client-incompatible');
  assert.equal(f.calls(), 0); assert.deepEqual(f.commits, []);
});

test('identity check detects token replacement or verification after authorization', async () => {
  const f = fixture();
  await f.run(authorizeAudioToken, { token: 'new-token' });
  f.state.user.authToken = 'changed';
  assert.equal(f.run(audioTokenMatches, 'new-token').reason, 'token-replaced');
  f.state.user.authToken = 'new-token'; f.state.system.captchaRequired = true;
  assert.equal(f.run(audioTokenMatches, 'new-token').reason, 'verification-required');
});

test('authorization errors expose fixed categories without reflecting secrets', () => {
  for (const reason of ['client-not-ready', 'client-incompatible', 'verification-required', 'token-replaced',
    'storage-mismatch', 'authorization-timeout', 'secret-new-token']) {
    const error = authorizationError(reason);
    assert(error.code.startsWith('NEKTO_')); assert(error.message.startsWith('Nekto '));
    assert(!error.message.includes('secret-new-token'));
  }
});
