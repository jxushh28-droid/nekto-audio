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
  const loadingEvents = [];
  browser.newContext = async (...args) => {
    contextsCreated++;
    const context = await newContext(...args);
    await context.route('**/*', async route => {
      const request = route.request();
      requests.push({ host: new URL(request.url()).hostname, headers: request.headers() });
      const path = new URL(request.url()).pathname;
      if (path === '/recaptcha/api2/anchor') {
        // Delayed cross-origin document and image: inserting an iframe alone
        // must not qualify as a fully loaded CAPTCHA.
        await new Promise(resolve => setTimeout(resolve, 500));
        await route.fulfill({ contentType: 'text/html', body: '<!doctype html><img src="/recaptcha/fixture-image.png"><button>Fixture checkbox</button>' });
        return;
      }
      if (path === '/recaptcha/fixture-image.png') {
        await new Promise(resolve => setTimeout(resolve, 500));
        await route.fulfill({ contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') });
        loadingEvents.push('image-loaded');
        return;
      }
      const nekto = new URL(request.url()).hostname === new URL(NEKTO_URL).hostname;
      const challenge = nekto && challengesRemaining > 0;
      if (nekto) nektoLoads++;
      if (nekto) loadingEvents.push('entry-load');
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
          window.showChallenge = () => {
            store.state.system.captchaRequired = true;
            setTimeout(() => {
              const frame = document.createElement('iframe'); frame.title = 'reCAPTCHA';
              frame.src = 'https://www.google.com/recaptcha/api2/anchor'; document.body.append(frame);
            }, 400);
          };
          document.querySelector('#searchCompanyBtn').onclick = () => {
            window.nativeStarts++; store.state.user.isSearching = true;
            if (${challenge}) window.showChallenge();
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
      webdriver: navigator.webdriver,
      screen: [screen.width, screen.height, screen.availWidth, screen.availHeight],
      crypto: [native(crypto.subtle.encrypt), native(crypto.subtle.decrypt)],
      rtc: native(RTCPeerConnection), gum: native(navigator.mediaDevices.getUserMedia),
      canvas: canvas.toDataURL(), offlineAudio: native(OfflineAudioContext.prototype.startRendering),
    };
  };
  baseline = await browser.newContext({ viewport: null });
  const normal = await baseline.newPage(); await normal.goto(NEKTO_URL);
  const expectedIdentity = await normal.evaluate(identity);
  assert.equal(expectedIdentity.webdriver, true, 'Browser launch suppressed the native automation indicator');
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
  await page.evaluate(() => window.showChallenge());
  await page.locator('iframe[title="reCAPTCHA"]').waitFor();
  await page.frameLocator('iframe[title="reCAPTCHA"]').locator('img').evaluate(image => image.decode());
  for (let i = 0; i < 50 && relay.forwarding; i++) await new Promise(resolve => setTimeout(resolve, 50));
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(loadingEvents.at(-1), 'image-loaded', 'Delayed CAPTCHA image did not finish loading');
  assert.equal(nektoLoads, loadsBeforeLateChallenge, 'Late challenge caused an entry navigation or reload');
  assert.equal(await page.evaluate(() => window.nativeStarts), 1, 'Late challenge caused another Start click');
  assert.equal(relay.context, currentContext, 'Verification replaced the browser context');
  assert.equal(relay.page, page);
  assert.equal(relay.forwarding, false);
  assert.equal(relay.searchIntent, false);
  assert.equal((await relay.status('fixture-native-token')).authorizationDiagnostics.captcha, true);
  await assert.rejects(relay.next('fixture-native-token'), error => error.code === 'NEKTO_VERIFICATION');
  await assert.rejects(relay.search('fixture-native-token'), error => error.code === 'NEKTO_VERIFICATION');
  assert.equal(nektoLoads, loadsBeforeLateChallenge, 'Next/join navigated away from verification');
  assert.equal(await page.evaluate(() => window.nativeStarts), 1, 'Next/join pressed Start during verification');
  // The fixture simulates the owner completing the native challenge.
  await page.evaluate(() => {
    document.querySelector('#app').__vue__.$store.state.system.captchaRequired = false;
    document.querySelectorAll('iframe').forEach(frame => frame.remove());
  });
  for (let i = 0; i < 50 && !relay.forwarding; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(relay.forwarding, true, 'Existing native search did not resume after owner verification');
  assert.equal(await page.evaluate(() => window.nativeStarts), 1, 'Cleared verification pressed Start again');
  await page.getByRole('button', { name: 'Остановить поиск', exact: true }).click();
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(await page.evaluate(() => window.nativeStarts), 1, 'Monitor restarted a manually stopped search');
  assert.equal(relay.forwarding, false);
  relay.stopSessionMonitor();
  const contextsBeforeChallenge = contextsCreated, loadsBeforeChallenge = nektoLoads;
  challengesRemaining = 1;
  await assert.rejects(relay.openSession('fixture-native-token'), error => error.code === 'NEKTO_VERIFICATION');
  page = relay.page;
  await page.locator('iframe[title="reCAPTCHA"]').waitFor();
  await page.frameLocator('iframe[title="reCAPTCHA"]').locator('img').evaluate(image => image.decode());
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(nektoLoads, loadsBeforeChallenge + 1, 'Immediate challenge reloaded the entry page');
  assert.equal(contextsCreated, contextsBeforeChallenge + 1, 'Immediate challenge created another context');
  assert.equal(await page.evaluate(() => window.nativeStarts), 1, 'Immediate challenge repeated Start');
  assert.equal(relay.forwarding, false);
  assert.equal(relay.searchIntent, false);
  const challengedPage = page;
  await assert.rejects(relay.next('fixture-native-token'), error => error.code === 'NEKTO_VERIFICATION');
  await assert.rejects(relay.search('fixture-native-token'), error => error.code === 'NEKTO_VERIFICATION');
  assert.equal(relay.page, challengedPage, 'Commands replaced the challenge page');
  assert.equal(nektoLoads, loadsBeforeChallenge + 1, 'Commands reloaded the immediate challenge');
  assert.equal(await page.evaluate(() => window.nativeStarts), 1);
  assert.equal((await relay.status('fixture-native-token')).authorizationDiagnostics.captcha, true);
  challengesRemaining = 0;
  await relay.openSession('fixture-native-token'); page = relay.page;
  await page.getByRole('button', { name: 'Остановить поиск', exact: true }).click();
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(await page.evaluate(() => window.nativeStarts), 1, 'Stop restarted search');
  relay.stopSessionMonitor();
  // Manual mode exercises production registration without any automatic Start.
  relay.manualSearch = true;
  const beforeManual = nektoLoads;
  assert.match(await relay.openSession('fixture-native-token'), /^Nekto is ready\. Click Search/);
  page = relay.page;
  assert.equal(await page.evaluate(() => window.nativeStarts), 0, 'Manual session clicked Start automatically');
  assert.equal(relay.waitingForManualSearch, true);
  assert.equal(relay.forwarding, false);
  await page.getByRole('button', { name: 'Начать разговор', exact: true }).click(); // Simulates the owner's UI action.
  for (let i = 0; i < 50 && !relay.forwarding; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(relay.forwarding, true, 'Manually started search did not resume the relay');
  assert.equal(relay.waitingForManualSearch, false);
  await page.evaluate(() => {
    const store = document.querySelector('#app').__vue__.$store;
    store.state.user.isSearching = false;
    const finished = document.createElement('p'); finished.className = 'callScreen__finishText';
    finished.textContent = 'Собеседник завершил разговор'; document.body.append(finished);
  });
  for (let i = 0; i < 50 && !relay.waitingForManualSearch; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(relay.waitingForManualSearch, true, 'Partner leaving did not return to manual Search');
  assert.equal(await page.evaluate(() => window.nativeStarts), 1, 'Partner leaving clicked Start automatically');
  assert.match(await relay.next('fixture-native-token'), /^Nekto is ready\. Click Search/);
  assert.equal(await page.evaluate(() => window.nativeStarts), 1, 'Manual Next clicked Start automatically');
  await page.evaluate(() => window.showChallenge());
  await assert.rejects(relay.next('fixture-native-token'), error => error.code === 'NEKTO_VERIFICATION');
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(nektoLoads, beforeManual + 1, 'Manual verification was automatically reloaded');
  assert.equal((await relay.status('fixture-native-token')).authorizationDiagnostics.captcha, true);
  relay.stopSessionMonitor();
  await page.evaluate(() => {
    document.querySelector('#app').__vue__.$store.state.system.captchaRequired = false;
    document.querySelectorAll('iframe, .callScreen__finishText').forEach(element => element.remove());
  });
  await page.evaluate(() => {
    const frame = document.createElement('iframe'); frame.src = 'https://www.google.com/recaptcha/fixture'; document.body.append(frame);
  });
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', { name: 'Начать разговор', exact: true }).waitFor();
  assert.equal(await frame.locator('body').evaluate(() => localStorage.getItem('storage_audio_v2')), null, 'CAPTCHA frame received the token');
  const googleTab = await relay.context.newPage();
  await googleTab.goto('https://www.google.com/fixture');
  assert.equal(await googleTab.evaluate(() => localStorage.getItem('storage_audio_v2')), null, 'Third-party tab received the token');
  assert.equal(await googleTab.evaluate(() => !!window.__nektoRelay), false);
  assert.equal(await googleTab.evaluate(() => typeof window.showChallenge), 'function', 'JavaScript did not run in the new tab');
  assert.deepEqual(await googleTab.evaluate(identity), expectedIdentity);
  assert.equal(await frame.locator('body').evaluate(() => localStorage.getItem('storage_audio_v2')), null);
  await googleTab.close();
  await page.goto('https://www.google.com/fixture');
  assert.equal(await page.evaluate(() => localStorage.getItem('storage_audio_v2')), null, 'Third-party navigation received the token');
  assert.equal(await page.evaluate(() => !!window.__nektoRelay), false);
  assert.deepEqual(await page.evaluate(identity), expectedIdentity);
  for (const request of requests.filter(request => request.host === 'www.google.com')) {
    assert.equal(request.headers.origin, undefined, 'Google document request received a forced Nekto Origin');
  }
  assert(requests.some(request => request.host === 'www.google.com'));
  console.log('Browser compatibility passed: production session, native identity/crypto and automation indicator, new-tab JavaScript, scoped Google/CAPTCHA setup, single Start attempt, delayed widget/image loading without entry navigation or reload, Next/join preserve verification, manual Stop respected, manual Search/Next with no automatic Start or challenge reload.');
} finally {
  await baseline?.close();
  await relay?.close();
  await browser?.close();
  await rm(directory, { recursive: true, force: true });
}
