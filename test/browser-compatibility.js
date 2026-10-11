import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { NektoBrowser, NEKTO_URL } from '../src/nekto.js';
import { browserLaunchOptions } from '../src/token-extension.js';
import { writeSilentMicrophone } from '../src/silent-microphone.js';

// Exercise the production openSession path against synthetic pages only.
// No requests reach Nekto, Google or any other external service.
const directory = await mkdtemp(join(tmpdir(), 'native-session-test-'));
const microphonePath = join(directory, 'silent-microphone.wav');
let browser, relay, baseline;
try {
  await writeSilentMicrophone(microphonePath);
  browser = await chromium.launch({ ...browserLaunchOptions(microphonePath),
    channel: 'chromium', headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH });
  const newContext = browser.newContext.bind(browser);
  const requests = [];
  let challengesRemaining = 0, nektoLoads = 0, contextsCreated = 0;
  browser.newContext = async (...args) => {
    contextsCreated++;
    const context = await newContext(...args);
    await context.route('**/*', async route => {
      const request = route.request();
      requests.push({ host: new URL(request.url()).hostname, headers: request.headers() });
      const nekto = new URL(request.url()).hostname === new URL(NEKTO_URL).hostname;
      const challenge = nekto && challengesRemaining > 0;
      if (nekto) nektoLoads++;
      if (challenge) challengesRemaining--;
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html>
        <div id="app"><button id="searchCompanyBtn">Начать разговор</button>
        <button id="manual-stop">Остановить поиск</button></div>
        <script>
          window.tokenAtFirstScript = JSON.parse(localStorage.getItem('storage_audio_v2') || '{}').user?.authToken;
          const store = { state: { user: { authToken: window.tokenAtFirstScript, tokenId: 0, isSearching: false },
            system: { isAuth: true, socketConnected: true, isFirstLoaded: true }, chat: {} },
            subscribe() { return () => {}; } };
          document.querySelector('#app').__vue__ = { $store: store };
          window.nativeStarts = 0;
          document.querySelector('#searchCompanyBtn').onclick = () => {
            window.nativeStarts++; store.state.user.isSearching = true;
            if (${challenge}) store.state.system.captchaRequired = true;
          };
          document.querySelector('#manual-stop').onclick = () => { store.state.user.isSearching = false; };
        </script>` });
    });
    return context;
  };
  const identity = () => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#123456'; ctx.fillRect(0, 0, 12, 12);
    const native = fn => Function.prototype.toString.call(fn);
    return {
      ua: navigator.userAgent, platform: navigator.platform, language: navigator.language,
      hints: navigator.userAgentData?.toJSON(), memory: navigator.deviceMemory,
      concurrency: navigator.hardwareConcurrency,
      plugins: Array.from(navigator.plugins, plugin => ({ name: plugin.name, mime: plugin.item(0)?.type })),
      ownPlugins: Object.hasOwn(navigator, 'plugins'), ownWebdriver: Object.hasOwn(navigator, 'webdriver'),
      screen: [screen.width, screen.height, screen.availWidth, screen.availHeight],
      crypto: [native(crypto.subtle.encrypt), native(crypto.subtle.decrypt)],
      rtc: native(RTCPeerConnection), gum: native(navigator.mediaDevices.getUserMedia),
      canvas: canvas.toDataURL(), offlineAudio: native(OfflineAudioContext.prototype.startRendering),
    };
  };
  baseline = await browser.newContext({ viewport: null });
  const normal = await baseline.newPage(); await normal.goto(NEKTO_URL);
  const expectedIdentity = await normal.evaluate(identity);
  await baseline.close(); baseline = null;
  relay = new NektoBrowser(() => {}, directory); relay.browser = browser;
  assert.match(await relay.openSession('fixture-native-token'), /^Searching on Nekto/);
  let page = relay.page;
  assert.equal(await page.evaluate(() => window.tokenAtFirstScript), 'fixture-native-token');
  assert.equal((await relay.status('fixture-native-token')).authorizationDiagnostics.liveTokenMatches, true);
  assert.deepEqual(await page.evaluate(identity), expectedIdentity, 'Production setup changed the native browser fingerprint');
  const cryptoRoundTrip = await page.evaluate(async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const algorithm = { name: 'AES-GCM', iv: new Uint8Array(12) };
    const body = JSON.stringify({ type: 'register', authToken: 'fixture-native-token', fpt: 'native-fingerprint', deviceInfo: { platform: navigator.platform } });
    const encrypted = await crypto.subtle.encrypt(algorithm, key, new TextEncoder().encode(body));
    return new TextDecoder().decode(await crypto.subtle.decrypt(algorithm, key, encrypted)) === body;
  });
  assert.equal(cryptoRoundTrip, true, 'Native fingerprint/registration payload was rewritten');
  const loadsBeforeLateChallenge = nektoLoads, currentContext = relay.context;
  await page.evaluate(() => document.querySelector('#app').__vue__.$store.state.system.captchaRequired = true);
  await page.waitForFunction(() => !document.querySelector('#app').__vue__.$store.state.system.captchaRequired);
  assert.equal(nektoLoads, loadsBeforeLateChallenge + 1, 'Late challenge did not return to the audio entry page once');
  assert.equal(relay.context, currentContext, 'Recovery changed browser identity/context');
  assert.equal(relay.page, page);
  await page.waitForFunction(() => window.nativeStarts === 1);
  await relay.entryRetryPromise;
  assert.equal(relay.forwarding, true, 'Recovered search did not resume forwarding');
  await page.getByRole('button', { name: 'Остановить поиск', exact: true }).click();
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(await page.evaluate(() => window.nativeStarts), 1, 'Monitor restarted a manually stopped search');
  assert.equal(relay.forwarding, false);
  relay.stopSessionMonitor();
  const contextsBeforeRecovery = contextsCreated, loadsBeforeRecovery = nektoLoads;
  challengesRemaining = 1;
  assert.match(await relay.openSession('fixture-native-token'), /^Searching on Nekto/);
  page = relay.page;
  assert.equal(nektoLoads, loadsBeforeRecovery + 2, 'Immediate challenge did not retry exactly once');
  assert.equal(contextsCreated, contextsBeforeRecovery + 1, 'Recovery created another context');
  assert.equal((await relay.status('fixture-native-token')).authorizationDiagnostics.liveTokenMatches, true);
  const loadsBeforePersistentChallenge = nektoLoads;
  challengesRemaining = 3;
  await assert.rejects(relay.openSession('fixture-native-token'), error => error.code === 'NEKTO_VERIFICATION');
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(nektoLoads, loadsBeforePersistentChallenge + 2, 'Persistent verification caused an unbounded reload loop');
  assert.equal(relay.forwarding, false);
  assert.equal((await relay.status('fixture-native-token')).authorizationDiagnostics.captcha, true);
  challengesRemaining = 0;
  await relay.openSession('fixture-native-token'); page = relay.page;
  await page.getByRole('button', { name: 'Остановить поиск', exact: true }).click();
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(await page.evaluate(() => window.nativeStarts), 1, 'Stop after recovery restarted search');
  relay.stopSessionMonitor();
  await page.evaluate(() => {
    const frame = document.createElement('iframe'); frame.src = 'https://www.google.com/recaptcha/fixture'; document.body.append(frame);
  });
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', { name: 'Начать разговор', exact: true }).waitFor();
  assert.equal(await frame.locator('body').evaluate(() => localStorage.getItem('storage_audio_v2')), null, 'CAPTCHA frame received the token');
  await page.goto('https://www.google.com/fixture');
  assert.equal(await page.evaluate(() => localStorage.getItem('storage_audio_v2')), null, 'Third-party navigation received the token');
  assert.equal(await page.evaluate(() => !!window.__nektoRelay), false);
  assert.deepEqual(await page.evaluate(identity), expectedIdentity);
  for (const request of requests.filter(request => request.host === 'www.google.com')) {
    assert.equal(request.headers.origin, undefined, 'Google document request received a forced Nekto Origin');
  }
  assert(requests.some(request => request.host === 'www.google.com'));
  console.log('Browser compatibility passed: production session, native identity/crypto, scoped Google/CAPTCHA setup, one same-page challenge retry, persistent challenge preserved, manual Stop respected.');
} finally {
  await baseline?.close();
  await relay?.close();
  await browser?.close();
  await rm(directory, { recursive: true, force: true });
}
