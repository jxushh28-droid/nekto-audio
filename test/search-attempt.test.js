import test from 'node:test';
import assert from 'node:assert/strict';
import { NektoBrowser, NEKTO_URL } from '../src/nekto.js';
import { searchError } from '../src/search-error.js';

const ready = { searching: false, partnerConnected: false, verification: false, restricted: false, attention: false };
function fixture({ verification = false, challengeOnStart = false } = {}) {
  let state = { ...ready, verification }, starts = 0, loads = 0;
  const empty = { count: async () => 0, or(other) { return other; }, filter() { return this; } };
  const start = { count: async () => 1, nth: () => ({ isVisible: async () => true, isEnabled: async () => true,
    click: async () => { starts++; state.searching = true; state.verification = challengeOnStart; } }) };
  const page = { url: () => NEKTO_URL, isClosed: () => false,
    locator: selector => selector === '#searchCompanyBtn' ? start : empty,
    getByRole: () => empty,
    evaluate: async fn => fn.name === 'readAudioCallState' ? { ...state } :
      fn.name === 'readNativeControls' ? [] : fn.name === 'confirmAudioToken' ? {
        ok: !state.verification, reason: state.verification ? 'verification-required' : 'native-session-confirmed',
        diagnostics: { savedTokenMatches: true, liveTokenMatches: true, identityPresent: true,
          authenticated: true, socketConnected: true, captcha: state.verification },
      } : null };
  const browser = new NektoBrowser(() => {});
  browser.manualSearch = false; browser.page = page;
  browser.startSessionMonitor = () => {};
  browser.loadAndSearch = async () => { loads++; throw Error('must not navigate'); };
  return { browser, page, counts: () => ({ starts, loads }) };
}

test('Next and repeated join leave existing verification in place without Start or navigation', async () => {
  const f = fixture({ verification: true });
  for (const action of [() => f.browser.next('fixture-token'), () => f.browser.search('fixture-token')]) {
    await assert.rejects(action(), error => error.code === 'NEKTO_VERIFICATION');
  }
  assert.deepEqual(f.counts(), { starts: 0, loads: 0 });
  assert.equal(f.browser.page, f.page);
  assert.equal(f.browser.searchIntent, false);
});

test('a challenge after the single Start click cannot trigger an entry reload or second click', async () => {
  const f = fixture({ challengeOnStart: true });
  await assert.rejects(f.browser.next('fixture-token'), error => error.code === 'NEKTO_VERIFICATION');
  assert.deepEqual(f.counts(), { starts: 1, loads: 0 });
  assert.equal(f.browser.searchIntent, false);
  assert.equal(f.browser.forwarding, false);
  assert.equal(f.browser.page, f.page);
  await assert.rejects(f.browser.search('fixture-token'), error => error.code === 'NEKTO_VERIFICATION');
  assert.deepEqual(f.counts(), { starts: 1, loads: 0 });
});

test('a failed confirmation disarms the monitor instead of scheduling another search attempt', async () => {
  const f = fixture();
  f.browser.finishSearch = async () => { throw searchError('confirm'); };
  await assert.rejects(f.browser.next('fixture-token'), error => /^NEKTO_/.test(error.code));
  assert.deepEqual(f.counts(), { starts: 1, loads: 0 });
  assert.equal(f.browser.searchIntent, false);
  assert.equal(f.browser.partnerSeen, false);
  assert.equal(f.browser.forwarding, false);
});

test('Next waits for a monitor-owned call transition before cancelling its monitor', async () => {
  const f = fixture();
  let release, advanced = false;
  const version = f.browser.monitorVersion;
  f.browser.callAdvancePromise = new Promise(resolve => { release = resolve; });
  f.browser.advanceSearch = async () => { advanced = true; };
  const next = f.browser.next('fixture-token');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.browser.monitorVersion, version);
  assert.equal(advanced, false);
  release(); await next;
  assert.equal(advanced, true);
});
