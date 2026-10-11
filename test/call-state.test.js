import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readAudioCallState, waitForAudioSearch } from '../src/call-state.js';

function read({ user = {}, chat = {}, system = {}, visible = [], hash = '#/' } = {}) {
  return vm.runInNewContext(`(${readAudioCallState.toString()})()`, {
    document: {
      querySelectorAll: selector => selector === '*' ? [{ __vue__: { $store: { state: { user, chat, system: { isAuth: true, socketConnected: true, ...system } } } } }]
        : visible.includes(selector) ? [{ isConnected: true, getClientRects: () => [1] }] : [],
    }, location: { hash }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  });
}

test('native search and partner connection are separate from merely opening the page', () => {
  assert.equal(read().phase, 'idle/loading');
  assert.equal(read({ visible: ['#searchCompanyBtn'] }).phase, 'ready to search');
  assert.equal(read({ user: { isSearching: true } }).phase, 'searching for a partner');
  assert.equal(read({ hash: '#/searching' }).searching, true);
  const connected = read({ chat: { activeConnectionId: 'private-partner-id' } });
  assert.equal(connected.phase, 'partner connected'); assert.equal(connected.partnerConnected, true);
  assert(!JSON.stringify(connected).includes('private-partner-id'));
});

test('native finished-call screen differs from a manually stopped search', () => {
  assert.equal(read({ visible: ['.callScreen__finishText'] }).callEnded, true);
  assert.equal(read({ visible: ['#searchCompanyBtn'] }).callEnded, false);
  assert.equal(read({ chat: { activeConnectionId: 1 }, visible: ['.callScreen__finishText'] }).callEnded, false);
});

test('a stale isSearching flag cannot turn an active or ended native call into a search', () => {
  const user = { isSearching: true };
  const active = read({ user, chat: { activeConnectionId: 1 }, hash: '#/peer' });
  assert.equal(active.partnerConnected, true); assert.equal(active.searching, false);
  const ended = read({ user, visible: ['.callScreen__finishText'], hash: '#/peer' });
  assert.equal(ended.callEnded, true); assert.equal(ended.searching, false);
  assert.equal(ended.phase, 'call ended; ready to search');
  const rendering = read({ user, hash: '#/peer' });
  assert.equal(rendering.searching, false, 'Ending a call must wait for Start, not reuse the stale flag');
  const transitioning = read({ user, hash: '#/searching', visible: ['.callScreen__finishText'] });
  assert.equal(transitioning.searching, false, 'Old call UI cannot confirm that the new search has begun');
  assert.equal(read({ user, hash: '#/searching' }).searching, true);
  assert.equal(user.isSearching, true, 'Reading state must not change native flags');
});

test('verification, restrictions and website prompts prevent a connected status', () => {
  for (const options of [{ system: { captchaRequired: true } }, { system: { forceDisconnectReason: 'private-restriction' } },
    { visible: ['#mask_bad_inet'] }, { visible: ['.swal2-popup'] }]) {
    const result = read({ chat: { activeConnectionId: 1 }, ...options });
    assert.equal(result.partnerConnected, false); assert(!JSON.stringify(result).includes('private-restriction'));
  }
});

test('hidden or disabled Start buttons alone cannot confirm a search', async () => {
  await assert.rejects(waitForAudioSearch({ evaluate: async () => read() }, { timeout: 5, interval: 1 }),
    error => error.code === 'NEKTO_SEARCH_UNCONFIRMED');
});

test('new search confirmation waits for the finished-call UI to disappear despite its stale search flag', async () => {
  let evaluations = 0;
  const page = { evaluate: async () => {
    evaluations++;
    return read({ user: { isSearching: true }, hash: evaluations < 3 ? '#/peer' : '#/searching',
      visible: evaluations < 3 ? ['.callScreen__finishText'] : [] });
  } };
  assert.equal((await waitForAudioSearch(page, { interval: 1 })).searching, true);
  assert.equal(evaluations, 3);
});

test('search confirmation observes native transition and respects cancellation', async () => {
  let evaluations = 0;
  const page = { evaluate: async fn => {
    assert.equal(fn, readAudioCallState);
    return ++evaluations === 1 ? read({ visible: ['#searchCompanyBtn'] }) : read({ user: { isSearching: true } });
  } };
  assert.equal((await waitForAudioSearch(page, { interval: 1 })).searching, true);
  await assert.rejects(waitForAudioSearch(page, { check() { throw new Error('cancelled'); } }), /cancelled/);
  assert.equal(evaluations, 2);
});
