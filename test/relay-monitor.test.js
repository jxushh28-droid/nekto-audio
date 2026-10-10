import test from 'node:test';
import assert from 'node:assert/strict';
import { NektoBrowser, canForwardAudio } from '../src/nekto.js';

const identity = () => ({
  savedTokenMatches: true, liveTokenMatches: true, identityPresent: true,
  authenticated: true, socketConnected: true, captcha: false, hcaptcha: false,
  restricted: false, registrationError: 0,
});
const connected = () => ({
  phase: 'partner connected', searching: false, partnerConnected: true,
  verification: false, restricted: false, attention: false,
});
const observed = () => ({
  callState: connected(), authorizationDiagnostics: identity(),
  authorizationReason: 'native-session-confirmed',
});
const until = async predicate => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Monitor did not reach expected state');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

test('forwarding requires a confirmed unrestricted native call', () => {
  assert.equal(canForwardAudio(observed(), null), true);
  for (const key of ['verification', 'restricted', 'attention']) {
    const value = observed(); value.callState[key] = true;
    assert.equal(canForwardAudio(value, null), false, key);
  }
  for (const key of ['savedTokenMatches', 'liveTokenMatches', 'identityPresent', 'authenticated', 'socketConnected']) {
    const value = observed(); value.authorizationDiagnostics[key] = false;
    assert.equal(canForwardAudio(value, null), false, key);
  }
  for (const key of ['captcha', 'hcaptcha', 'restricted', 'registrationError']) {
    const value = observed(); value.authorizationDiagnostics[key] = true;
    assert.equal(canForwardAudio(value, null), false, key);
  }
  const idle = observed(); idle.callState.partnerConnected = false;
  assert.equal(canForwardAudio(idle, null), false);
  const search = observed(); search.callState.partnerConnected = false; search.callState.searching = true;
  assert.equal(canForwardAudio(search, null), true);
  const rejected = observed(); rejected.authorizationReason = 'token-not-accepted';
  assert.equal(canForwardAudio(rejected, null), false);
  assert.equal(canForwardAudio(observed(), 'capture failed'), false);
  assert.equal(canForwardAudio({}, null), false);
});

test('monitor recovers a cleared challenge and pauses on renewed verification', async () => {
  const browser = new NektoBrowser(() => {}, './unused-test-profile');
  let state = connected(), diagnostics = identity(), captureError = null, closed = false;
  const page = {
    isClosed: () => closed,
    evaluate: async fn => fn.name === 'readAudioCallState' ? { ...state } :
      fn.name === 'confirmAudioToken' ? {
        reason: diagnostics.captcha ? 'verification-required' : 'native-session-confirmed',
        diagnostics: { ...diagnostics },
      } : captureError,
  };
  browser.page = page;
  browser.lastFailure = { code: 'NEKTO_VERIFICATION' };
  try {
    browser.startSessionMonitor(page, 'test-token');
    await until(() => browser.forwarding);
    assert.equal(browser.lastFailure, null);
    state.verification = true; diagnostics.captcha = true;
    await until(() => !browser.forwarding);
    state.verification = false; diagnostics.captcha = false;
    await until(() => browser.forwarding);
    captureError = 'Remote audio capture failed.';
    await until(() => !browser.forwarding);
    await browser.stop();
    captureError = null;
    assert.equal(browser.page, null);
    assert.equal(browser.monitorTimer, null);
    assert.equal(browser.forwarding, false);
  } finally { browser.stopSessionMonitor(); }
});

test('an in-flight observation cannot re-enable a stopped session', async () => {
  const browser = new NektoBrowser(() => {}, './unused-test-profile');
  let release, entered = false;
  const paused = new Promise(resolve => { release = resolve; });
  const page = {
    isClosed: () => false,
    evaluate: async fn => {
      entered = true; await paused;
      return fn.name === 'readAudioCallState' ? connected() : { reason: 'native-session-confirmed', diagnostics: identity() };
    },
  };
  browser.page = page;
  browser.startSessionMonitor(page, 'test-token');
  try {
    await until(() => entered);
    await browser.stop();
    release();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(browser.forwarding, false);
    assert.equal(browser.monitorTimer, null);
  } finally { release(); browser.stopSessionMonitor(); }
});
