import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { audioClientReady, confirmAudioToken, authorizationError } from '../src/live-session.js';

function fixture({ authenticated = false, identity = null, subscribe = true } = {}) {
  const storage = new Map([['storage_audio_v2', JSON.stringify({ user: { authToken: 'audio-token' } })]]);
  const subscribers = new Set();
  let mutations = 0, authorizations = 0;
  const state = { user: { authToken: 'audio-token', tokenId: identity },
    system: { isFirstLoaded: true, socketConnected: true, isAuth: authenticated } };
  const store = { state, commit() { mutations++; },
    $socketActions: { authorize() { authorizations++; } } };
  if (subscribe) store.subscribe = callback => { subscribers.add(callback); return () => subscribers.delete(callback); };
  const context = vm.createContext({
    document: { querySelectorAll: () => [{ __vue__: { $store: { state: { user: {} } } } }, { __vue__: { $store: store } }] },
    localStorage: { getItem: key => storage.get(key) }, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  const run = (fn, args) => vm.runInContext(`(${fn.toString()})(${JSON.stringify(args)})`, context);
  const confirm = args => run(confirmAudioToken, { token: 'audio-token', timeout: 100, pollInterval: 5, ...args });
  const accept = () => { state.system.isAuth = true; state.user.tokenId = 0;
    subscribers.forEach(callback => callback({ type: 'user/socket_registered' })); };
  return { run, confirm, accept, state, store, storage, subscribers, writes: () => mutations + authorizations };
}

test('audio confirms native tokenId without text tokenModel or successToken event', async () => {
  const f = fixture({ authenticated: true, identity: 0 });
  assert.equal(f.run(audioClientReady), true);
  const result = await f.confirm();
  assert.equal(result.ok, true); assert.equal(result.reason, 'native-session-confirmed');
  assert.equal(result.diagnostics.identityPresent, true); assert.equal(f.writes(), 0);
  assert(!JSON.stringify(result).includes('audio-token'));
});

test('audio waits for native registration with an unrelated mutation', async () => {
  const f = fixture(); const pending = f.confirm();
  f.accept();
  const result = await pending;
  assert.equal(result.ok, true); assert.equal(f.subscribers.size, 0); assert.equal(f.writes(), 0);
});

test('audio observes native state even without Vuex subscription support', async () => {
  const f = fixture({ subscribe: false }); const pending = f.confirm();
  f.accept();
  assert.equal((await pending).ok, true); assert.equal(f.writes(), 0);
});

test('matching saved and live tokens do not imply completed audio registration', async () => {
  const f = fixture(); const result = await f.confirm({ timeout: 10 });
  assert.equal(result.ok, false); assert.equal(result.reason, 'authorization-timeout');
  assert.equal(result.diagnostics.liveTokenMatches, true); assert.equal(result.diagnostics.savedTokenMatches, true);
  assert.equal(result.diagnostics.authenticated, false); assert.equal(result.diagnostics.identityPresent, false);
  assert.equal(f.subscribers.size, 0);
});

test('text token model is insufficient for an audio identity', async () => {
  const f = fixture({ authenticated: true });
  f.state.user.tokenModel = { tokenInfo: { authToken: 'audio-token' } };
  const result = await f.confirm({ timeout: 10 });
  assert.equal(result.ok, false); assert.equal(result.diagnostics.identityPresent, false);
});

test('registration errors, verification and native restrictions stop audio search', async () => {
  for (const [field, value, reason] of [['captchaRequired', true, 'verification-required'],
    ['hcaptchaRequired', true, 'verification-required'], ['forceDisconnectReason', 'private-reason', 'native-restriction'],
    ['errorRegistered', 7, 'native-registration-error']]) {
    const f = fixture({ authenticated: true, identity: 1 }); f.state.system[field] = value;
    const result = await f.confirm();
    assert.equal(result.ok, false); assert.equal(result.reason, reason); assert.equal(f.writes(), 0);
    assert(!JSON.stringify(result).includes('private-reason'));
  }
});

test('token replacement and malformed audio storage are reported without credentials', async () => {
  for (const mode of ['live', 'saved', 'malformed']) {
    const f = fixture({ authenticated: true, identity: 1 });
    if (mode === 'live') f.state.user.authToken = 'private-replacement';
    else f.storage.set('storage_audio_v2', mode === 'malformed' ? 'broken' : '{}');
    const result = await f.confirm();
    assert.equal(result.ok, false); assert.equal(result.reason, 'token-not-accepted');
    assert(!JSON.stringify(result).includes('private-replacement'));
  }
});

test('disconnect and verification during registration clean up observers', async () => {
  const f = fixture(); const pending = f.confirm();
  f.state.system.socketConnected = false; f.accept();
  const result = await pending;
  assert.equal(result.ok, false); assert.equal(result.diagnostics.socketConnected, false);
  assert.equal(f.subscribers.size, 0);
  const other = fixture(); const blocked = other.confirm();
  other.state.system.captchaRequired = true; other.accept();
  assert.equal((await blocked).reason, 'verification-required'); assert.equal(other.subscribers.size, 0);
});

test('authorization errors use fixed messages without private values', () => {
  for (const reason of ['client-not-ready', 'verification-required', 'native-restriction',
    'native-registration-error', 'token-not-accepted', 'authorization-timeout', 'private-value']) {
    const error = authorizationError(reason);
    assert(error.code.startsWith('NEKTO_')); assert(error.message.startsWith('Nekto '));
    assert(!error.message.includes('private-value'));
  }
});
