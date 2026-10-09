import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceAudioCall } from '../src/call-controls.js';

const ready = { searching: false, partnerConnected: false, attention: false, verification: false, restricted: false };
function fixture(initial, { confirmation = false, unrelatedPrompt = false, missingEnd = false, failedEnd = false,
  fadeReads = 0, challengedAfterConfirm = false } = {}) {
  let state = { ...ready, ...initial }, authorized = 0, ended = 0, started = 0, confirmations = 0;
  const empty = () => ({ count: async () => 0, nth: () => null, or(other) { return other; }, filter() { return this; } });
  const buttons = (visible, click) => ({ count: async () => visible ? 1 : 0,
    nth: () => ({ isVisible: async () => visible, isEnabled: async () => true, click }),
    or() { return this; }, filter() { return this; },
  });
  const popup = {
    isVisible: async () => state.attention,
    innerText: async () => unrelatedPrompt ? 'Verify you are human' : 'Вы уверены, что хотите завершить разговор?',
    getByRole: role => role === 'link' ? empty() : buttons(true, async () => {
      confirmations++; state.partnerConnected = false;
      state.attention = fadeReads > 0;
      if (challengedAfterConfirm) state.verification = true;
    }),
    locator: () => empty(),
  };
  const page = {
    evaluate: async () => {
      if (confirmations && fadeReads > 0 && --fadeReads === 0) state.attention = false;
      return { ...state };
    },
    getByRole: role => role === 'link' ? empty() : buttons(!missingEnd, async () => {
      ended++;
      if (confirmation || unrelatedPrompt) state.attention = true;
      else if (!failedEnd) state.partnerConnected = false;
    }),
    locator: selector => selector === '.swal2-popup' ? {
      count: async () => state.attention ? 1 : 0, nth: () => popup,
    } : selector === '.btn' ? empty() : buttons(true, async () => { started++; state.searching = true; }),
  };
  return { page, options: { authorize: async () => { authorized++; }, timeout: 5, interval: 1 },
    counts: () => ({ authorized, ended, started, confirmations }) };
}

test('next keeps an active search running without extra clicks', async () => {
  const f = fixture({ searching: true });
  assert.equal((await advanceAudioCall(f.page, f.options)).searching, true);
  assert.deepEqual(f.counts(), { authorized: 1, ended: 0, started: 0, confirmations: 0 });
});

test('repeated join preserves an active partner without End or Start', async () => {
  const f = fixture({ partnerConnected: true });
  assert.equal((await advanceAudioCall(f.page, { ...f.options, endCurrentCall: false })).partnerConnected, true);
  assert.deepEqual(f.counts(), { authorized: 1, ended: 0, started: 0, confirmations: 0 });
});

test('native end confirmation can fade away without being answered twice', async () => {
  const f = fixture({ partnerConnected: true }, { confirmation: true, fadeReads: 4 });
  assert.equal((await advanceAudioCall(f.page, { ...f.options, timeout: 100 })).searching, true);
  assert.deepEqual(f.counts(), { authorized: 2, ended: 1, started: 1, confirmations: 1 });
  const blocked = fixture({ partnerConnected: true }, { confirmation: true, challengedAfterConfirm: true });
  await assert.rejects(advanceAudioCall(blocked.page, blocked.options), error => error.code === 'NEKTO_VERIFICATION');
  assert.equal(blocked.counts().started, 0);
});

test('next ends the native call before searching, including ordinary end confirmation', async () => {
  for (const confirmation of [false, true]) {
    const f = fixture({ partnerConnected: true }, { confirmation });
    assert.equal((await advanceAudioCall(f.page, f.options)).searching, true);
    assert.deepEqual(f.counts(), { authorized: 2, ended: 1, started: 1, confirmations: Number(confirmation) });
  }
});

test('restrictions and unrelated prompts never receive automatic responses or Start', async () => {
  for (const initial of [{ restricted: true }, { verification: true }, { attention: true }]) {
    const f = fixture(initial);
    await assert.rejects(advanceAudioCall(f.page, f.options), error => /^NEKTO_/.test(error.code));
    assert.deepEqual(f.counts(), { authorized: 0, ended: 0, started: 0, confirmations: 0 });
  }
  const f = fixture({ partnerConnected: true }, { unrelatedPrompt: true });
  await assert.rejects(advanceAudioCall(f.page, f.options), error => error.code === 'NEKTO_ATTENTION');
  assert.equal(f.counts().started, 0); assert.equal(f.counts().confirmations, 0);
});

test('missing controls, failed End and cancellation cannot start another call', async () => {
  for (const options of [{ missingEnd: true }, { failedEnd: true }]) {
    const f = fixture({ partnerConnected: true }, options);
    await assert.rejects(advanceAudioCall(f.page, f.options), error => /^NEKTO_NEXT_/.test(error.code));
    assert.equal(f.counts().started, 0);
  }
  const f = fixture({ partnerConnected: true });
  await assert.rejects(advanceAudioCall(f.page, { ...f.options, check() { throw Error('cancelled'); } }), /cancelled/);
  assert.equal(f.counts().ended, 0); assert.equal(f.counts().started, 0);
});
