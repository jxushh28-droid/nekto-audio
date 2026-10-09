import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForStartControl, inspectStartControls } from '../src/start-controls.js';

const ready = { verification: false, restricted: false, attention: false, searching: false, partnerConnected: false };
const collection = items => ({ count: async () => items.length, nth: i => ({
  isVisible: async () => items[i].visible !== false,
  isEnabled: async () => items[i].enabled !== false,
  click: items[i].click || (async () => {}),
}) });
const fixture = ({ start = [], cookies = [], fallback = [], state = ready } = {}) => ({
  locator: selector => collection(selector === '#acceptCookies' ? cookies : start),
  getByRole: () => collection(fallback), evaluate: async () => state,
});

test('Start lookup ignores hidden duplicates, waits for enabled controls, and supports labelled fallback', async () => {
  let clicks = 0;
  const page = fixture({ start: [{ visible: false }, { click: async () => clicks++ }] });
  const found = await waitForStartControl(page, { timeout: 5, interval: 1 });
  await found.button.click(); assert.equal(clicks, 1);
  assert.deepEqual(await inspectStartControls(page), { startMatches: 2, startVisible: 1, startEnabled: 1,
    cookiesMatches: 0, cookiesVisible: 0, cookiesEnabled: 0 });
  assert((await waitForStartControl(fixture({ fallback: [{}] }))).button);
  await assert.rejects(waitForStartControl(fixture({ start: [{ enabled: false }] }), { timeout: 5, interval: 1 }),
    error => error.code === 'NEKTO_START_CONTROL');
});

test('active search, verification, and ambiguous controls do not produce another Start click', async () => {
  assert.equal((await waitForStartControl(fixture({ state: { ...ready, searching: true } }))).button, null);
  await assert.rejects(waitForStartControl(fixture({ state: { ...ready, verification: true } })),
    error => error.code === 'NEKTO_VERIFICATION');
  await assert.rejects(waitForStartControl(fixture({ start: [{}, {}] })),
    error => error.code === 'NEKTO_START_AMBIGUOUS');
});

test('Start proceeds without interacting with cookie-consent controls', async () => {
  let cookiesClicked = 0, starts = 0;
  const cookie = { click: async () => { cookiesClicked++; throw Error('blocked optional cookie control'); } };
  const page = fixture({ start: [{ click: async () => starts++ }], cookies: [cookie, cookie] });
  const found = await waitForStartControl(page);
  await found.button.click();
  assert.equal(starts, 1); assert.equal(cookiesClicked, 0);
});
