import test from 'node:test';
import assert from 'node:assert/strict';
import { NektoBrowser, NEKTO_URL } from '../src/nekto.js';

test('entry recovery preserves the page, allows one native reload, and rechecks verification', async () => {
  const browser = new NektoBrowser(() => {});
  const page = { url: () => NEKTO_URL, evaluate: async () => ({ verification: true }),
    frames: () => [{ url: () => 'https://www.google.com/recaptcha/api2/anchor', evaluate: async () => true,
      frameElement: async () => ({ isVisible: async () => true, dispose: async () => {} }) }] };
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

test('next and repeated join keep the recovery budget until the session stops', async () => {
  const browser = new NektoBrowser(() => {});
  browser.page = { isClosed: () => false };
  browser.entryRetryUsed = true;
  browser.startSessionMonitor = () => {};
  let advances = 0;
  browser.advanceSearch = async () => { advances++; assert.equal(browser.entryRetryUsed, true); };
  await browser.next('fixture-token');
  await browser.next('fixture-token', { endCurrentCall: false });
  assert.equal(advances, 2);
  await browser.stop();
  assert.equal(browser.entryRetryUsed, false);
});

test('next waits for a monitor-owned recovery before cancelling its monitor', async () => {
  const browser = new NektoBrowser(() => {});
  browser.page = { isClosed: () => false };
  browser.entryRetryUsed = true;
  let release, advanced = false;
  const version = browser.monitorVersion;
  browser.entryRetryPromise = new Promise(resolve => { release = resolve; });
  browser.startSessionMonitor = () => {};
  browser.advanceSearch = async () => { advanced = true; };
  const next = browser.next('fixture-token');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(browser.monitorVersion, version);
  assert.equal(advanced, false);
  release(); await next;
  assert.equal(advanced, true);
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
