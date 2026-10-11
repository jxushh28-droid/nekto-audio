import test from 'node:test';
import assert from 'node:assert/strict';
import { NektoBrowser, NEKTO_URL } from '../src/nekto.js';

test('entry recovery preserves the page, allows one native reload, and rechecks verification', async () => {
  const browser = new NektoBrowser(() => {});
  const page = { url: () => NEKTO_URL };
  browser.page = page;
  browser.forwarding = true;
  let loads = 0;
  browser.loadAndSearch = async actual => {
    assert.equal(actual, page);
    loads++;
    throw Object.assign(new Error('Native verification remains required'), { code: 'NEKTO_VERIFICATION' });
  };
  await assert.rejects(browser.retryFromEntry(page, 'fixture-token', () => {}), error => error.code === 'NEKTO_VERIFICATION');
  await assert.rejects(browser.retryFromEntry(page, 'fixture-token', () => {}), error => error.code === 'NEKTO_VERIFICATION');
  assert.equal(loads, 1);
  assert.equal(browser.forwarding, false);
  assert.equal(browser.entryRetryPromise, null);
});

test('a replacement page, third-party navigation, or cancelled search cannot be reloaded', async () => {
  for (const kind of ['replacement', 'other-origin', 'cancelled']) {
    const browser = new NektoBrowser(() => {});
    const page = { url: () => kind === 'other-origin' ? 'https://www.google.com/recaptcha/' : NEKTO_URL };
    browser.page = kind === 'replacement' ? {} : page;
    let loads = 0;
    browser.loadAndSearch = async () => { loads++; };
    await assert.rejects(browser.retryFromEntry(page, 'fixture-token', () => {
      if (kind === 'cancelled') throw new Error('cancelled');
    }));
    assert.equal(loads, 0);
  }
});
