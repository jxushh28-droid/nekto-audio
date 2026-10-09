import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptCookieConsent, waitForStartControl, inspectStartControls } from '../src/start-controls.js';

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

test('cookie consent ignores hidden duplicates and identifies blocked cookie clicks accurately', async () => {
  let clicked = 0;
  await acceptCookieConsent(fixture({ cookies: [{ visible: false }, { click: async () => clicked++ }] }));
  assert.equal(clicked, 1);
  await assert.rejects(acceptCookieConsent(fixture({ cookies: [{ click: async () => { throw Error('blocked'); } }] })),
    error => error.code === 'NEKTO_COOKIE_CONSENT');
  await assert.rejects(acceptCookieConsent(fixture({ cookies: [{}, {}] })),
    error => error.code === 'NEKTO_COOKIE_CONSENT');
});
