import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsUserAgentOverride } from '../src/windows-spoof.js';

const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7259.2 Safari/537.36';

test('swaps the Linux OS token for Windows and keeps the real Chrome version', () => {
  const o = windowsUserAgentOverride(LINUX_UA);
  assert.match(o.userAgent, /\(Windows NT 10\.0; Win64; x64\)/);
  assert.doesNotMatch(o.userAgent, /Linux|X11/);
  assert.match(o.userAgent, /Chrome\/140\.0\.7259\.2 Safari\/537\.36/);
  assert.equal(o.platform, 'Win32');
});

test('normalises a HeadlessChrome marker to Chrome', () => {
  const o = windowsUserAgentOverride(LINUX_UA.replace('Chrome/140', 'HeadlessChrome/140'));
  assert.doesNotMatch(o.userAgent, /Headless/);
  assert.match(o.userAgent, /Chrome\/140/);
});

test('userAgentMetadata is a coherent Windows desktop profile matching the UA major', () => {
  const o = windowsUserAgentOverride(LINUX_UA);
  const m = o.userAgentMetadata;
  assert.equal(m.platform, 'Windows');
  assert.equal(m.mobile, false);
  assert.equal(m.architecture, 'x86');
  assert.equal(m.bitness, '64');
  assert.equal(m.fullVersion, '140.0.7259.2');
  const chrome = m.brands.find(b => b.brand === 'Google Chrome');
  assert.equal(chrome.version, '140');
  const chromeFull = m.fullVersionList.find(b => b.brand === 'Google Chrome');
  assert.equal(chromeFull.version, '140.0.7259.2');
});

test('also rewrites a macOS user-agent', () => {
  const macUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';
  const o = windowsUserAgentOverride(macUA);
  assert.match(o.userAgent, /\(Windows NT 10\.0; Win64; x64\)/);
  assert.doesNotMatch(o.userAgent, /Macintosh|Mac OS/);
});

test('falls back to a sane default when no Chrome version is present', () => {
  const o = windowsUserAgentOverride('Mozilla/5.0 (X11; Linux x86_64) Gecko');
  assert.equal(o.userAgentMetadata.brands.find(b => b.brand === 'Google Chrome').version, '140');
});
