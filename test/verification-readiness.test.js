import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { waitForVerificationWidget, verificationFrameLoaded } from '../src/verification-readiness.js';

test('widget readiness includes its document, content and images', () => {
  const read = document => vm.runInNewContext(`(${verificationFrameLoaded.toString()})()`, { document });
  const complete = { readyState: 'complete', body: { children: [1] }, images: [{ complete: true, naturalWidth: 100 }] };
  assert.equal(read(complete), true);
  for (const changed of [{ readyState: 'loading' }, { body: { children: [] } },
    { images: [{ complete: false, naturalWidth: 0 }] }, { images: [{ complete: true, naturalWidth: 0 }] }]) {
    assert.equal(read({ ...complete, ...changed }), false);
  }
});

test('verification waits for a visible provider frame to finish loading and settle', async () => {
  let reads = 0, disposed = 0;
  const frame = { url: () => 'https://www.google.com/recaptcha/api2/anchor',
    evaluate: async () => ++reads >= 3,
    frameElement: async () => ({ isVisible: async () => true, dispose: async () => { disposed++; } }) };
  const page = { evaluate: async () => ({ verification: true }), frames: () => [frame] };
  assert.equal(await waitForVerificationWidget(page, { timeout: 200, interval: 1, settleTime: 5 }), 'loaded');
  assert(reads >= 4); assert.equal(disposed, reads);
});

test('missing, hidden or failed widgets stay on the native challenge page', async () => {
  for (const frames of [[], [{ url: () => 'https://www.google.com/recaptcha/api2/anchor',
    frameElement: async () => ({ isVisible: async () => false, dispose: async () => {} }) }],
    [{ url: () => 'https://www.google.com/recaptcha/api2/anchor', frameElement: async () => { throw Error('loading'); } }]]) {
    await assert.rejects(waitForVerificationWidget({ evaluate: async () => ({ verification: true }), frames: () => frames },
      { timeout: 5, interval: 1, settleTime: 0 }), error => error.code === 'NEKTO_VERIFICATION');
  }
});

test('cleared verification, restrictions and cancellation are checked before frames', async () => {
  const page = state => ({ evaluate: async () => state, frames: () => { throw Error('must not inspect'); } });
  assert.equal(await waitForVerificationWidget(page({ verification: false })), 'cleared');
  await assert.rejects(waitForVerificationWidget(page({ verification: true, restricted: true })), error => error.code === 'NEKTO_RESTRICTED');
  await assert.rejects(waitForVerificationWidget(page({ verification: true }), { check() { throw Error('cancelled'); } }), /cancelled/);
});
