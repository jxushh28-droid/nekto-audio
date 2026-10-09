import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { installBrowserRelay, inspectBrowserMicrophone } from '../src/browser-init.js';
import { FRAME_BYTES } from '../src/pcm.js';
import { audioClientReady, confirmAudioToken } from '../src/live-session.js';
import { readAudioPrompt } from '../src/audio-prompt.js';
import { NektoBrowser } from '../src/nekto.js';
import { writeTokenExtension, extensionBrowserOptions } from '../src/token-extension.js';

// Local-only integration test: real Chromium/WebRTC/WebAudio, no Nekto call or Discord login.
const server = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><script>window.tokenAtFirstScript=JSON.parse(localStorage.getItem("storage_audio_v2")||"{}").user?.authToken;</script><title>Relay test</title>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const directory = await mkdtemp(join(tmpdir(), 'extension-browser-test-'));
const extensionPath = join(directory, 'extension');
const profilePath = join(directory, 'profile');
let context;
try {
  await writeTokenExtension(extensionPath, 'local-test-token', { matches: ['http://127.0.0.1/*'] });
  context = await chromium.launchPersistentContext(profilePath, {
    ...extensionBrowserOptions(extensionPath), executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
  });
  await context.grantPermissions(['microphone'], { origin });
  const page = await context.newPage();
  const frames = [];
  await page.exposeBinding('pushNektoAudio', (_, base64) => frames.push(Buffer.from(base64, 'base64')));
  await page.addInitScript(installBrowserRelay, { origin });
  await page.goto(origin);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('storage_audio_v2')).user.authToken), 'local-test-token');
  assert.equal(await page.evaluate(() => window.tokenAtFirstScript), 'local-test-token', 'Extension did not run before page scripts');
  const child = await page.evaluate(() => new Promise(resolve => {
    const frame = document.createElement('iframe'); frame.src = '/frame';
    frame.onload = () => resolve(frame.contentWindow.tokenAtFirstScript); document.body.append(frame);
  }));
  assert.equal(child, 'local-test-token', 'all_frames did not apply to same-origin frames');
  const unmatched = await context.newPage();
  await unmatched.route('http://unmatched.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Unmatched fixture</title>' }));
  await unmatched.goto('http://unmatched.invalid/');
  assert.equal(await unmatched.evaluate(() => localStorage.getItem('storage_audio_v2')), null);
  await unmatched.close();
  const microphone = await page.evaluate(inspectBrowserMicrophone);
  assert.equal(microphone.permission, 'granted');
  assert(microphone.inputs > 0); assert.equal(microphone.legacyApi, true);
  const microphonePaths = await page.evaluate(async () => {
    let expectedLabel;
    const check = stream => {
      const track = stream.getAudioTracks()[0];
      expectedLabel ??= track?.label;
      const result = stream.getAudioTracks().length === 1 && track.readyState === 'live' && track.label === expectedLabel;
      stream.getTracks().forEach(track => track.stop()); return result;
    };
    const results = { modern: check(await navigator.mediaDevices.getUserMedia({ audio: true, video: false })) };
    for (const name of ['getUserMedia', 'webkitGetUserMedia', 'mozGetUserMedia']) {
      if (typeof navigator[name] !== 'function') continue;
      results[name] = await new Promise((resolve, reject) => navigator[name]({ audio: true, video: false }, stream => resolve(check(stream)), reject));
    }
    return results;
  });
  assert(Object.values(microphonePaths).every(Boolean));
  assert.equal(microphonePaths.getUserMedia, true);
  // A minimal Vuex client fixture checks the serialized functions in real Chromium.
  await page.evaluate(() => {
    const subscribers = new Set();
    const store = {
      state: { user: { authToken: JSON.parse(localStorage.getItem('storage_audio_v2')).user.authToken, tokenId: null }, system: { isFirstLoaded: true, isAuth: false, socketConnected: true } },
      commit(type, token) {
        if (type !== 'user/setAuthToken') throw new Error('Wrong mutation');
        this.state.user.authToken = token;
      },
      subscribe(callback) { subscribers.add(callback); return () => subscribers.delete(callback); },
    };
    document.body.__vue__ = { $store: store };
    setTimeout(() => {
      store.state.user.tokenId = 0;
      store.state.system.isAuth = true;
      subscribers.forEach(callback => callback({ type: 'user/socket_registered' }));
    }, 100);
  });
  await page.waitForFunction(audioClientReady);
  const authorization = await page.evaluate(confirmAudioToken, { token: 'local-test-token' });
  assert.equal(authorization.ok, true);
  assert.equal(authorization.reason, 'native-session-confirmed');
  assert.equal(authorization.diagnostics.identityPresent, true);
  // Exercise /next against actual visible DOM controls without a new page or registration.
  await page.evaluate(() => {
    const store = document.body.__vue__.$store;
    store.state.chat = { activeConnectionId: 1 };
    window.nativeStarts = 0; window.nativeEnds = 0;
    const end = document.createElement('button'); end.textContent = 'Завершить разговор';
    const start = document.createElement('button'); start.id = 'searchCompanyBtn'; start.textContent = 'Начать'; start.hidden = true;
    end.onclick = () => {
      window.nativeEnds++;
      const modal = document.createElement('div'); modal.className = 'swal2-popup';
      modal.textContent = 'Вы уверены, что хотите завершить разговор?';
      const yes = document.createElement('button'); yes.textContent = 'Да';
      yes.onclick = () => { store.state.chat.activeConnectionId = null; modal.remove(); end.hidden = true; start.hidden = false; };
      modal.append(yes); document.body.append(modal);
    };
    start.onclick = () => { window.nativeStarts++; store.state.user.isSearching = true; start.hidden = true; };
    document.body.append(end, start);
  });
  const relaySession = new NektoBrowser(() => {});
  relaySession.page = page;
  relaySession.context = { close() { throw Error('Unexpected context close'); } };
  relaySession.browser = { newContext() { throw Error('Unexpected new registration'); } };
  await relaySession.next('local-test-token');
  await relaySession.next('local-test-token'); // Already searching: do not click Start again.
  assert.equal(relaySession.page, page); assert.equal(relaySession.forwarding, true);
  assert.deepEqual(await page.evaluate(() => [window.nativeStarts, window.nativeEnds]), [1, 1]);
  await page.evaluate(() => { document.body.__vue__.$store.state.system.forceDisconnectReason = 7; });
  await assert.rejects(relaySession.next('local-test-token'), error => error.code === 'NEKTO_RESTRICTED');
  assert.equal(relaySession.page, page); assert.equal(relaySession.forwarding, false);
  await page.evaluate(() => {
    delete document.body.__vue__.$store.state.system.forceDisconnectReason;
    document.querySelectorAll('button').forEach(button => button.remove());
  });
  relaySession.authorization = 'native-session-confirmed';
  await page.evaluate(() => { document.body.__vue__.$store.state.system.hcaptchaRequired = true; });
  await assert.rejects(relaySession.finishSearch(page, 'local-test-token', () => {}, 'after-start'),
    error => error.code === 'NEKTO_VERIFICATION');
  assert.equal(relaySession.authorizationDiagnostics.hcaptcha, true);
  assert.equal(relaySession.authorizationDiagnostics.liveTokenMatches, true);
  assert.equal(relaySession.observedStage, 'after-start');
  assert.equal(relaySession.authorization, 'native-session-confirmed');
  await page.evaluate(() => { delete document.body.__vue__.$store.state.system.hcaptchaRequired; });
  const connectLoopback = async (suppressTrackEvents = false) => {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (mic.getAudioTracks().length !== 1) throw new Error('Silent microphone missing');
    const audio = new AudioContext({ sampleRate: 48000 });
    const source = audio.createOscillator(); source.frequency.value = 440;
    const output = audio.createMediaStreamDestination(); source.connect(output); source.start(); await audio.resume();
    window.testAudio = audio; window.testTone = source;
    const prototype = RTCPeerConnection.prototype;
    const nativeAdd = prototype.addEventListener;
    if (suppressTrackEvents) prototype.addEventListener = function(type, ...args) {
      if (type !== 'track') return nativeAdd.call(this, type, ...args);
    };
    let sender, receiver;
    try {
      sender = new RTCPeerConnection({ iceServers: [] });
      receiver = new RTCPeerConnection({ iceServers: [] });
    } finally { prototype.addEventListener = nativeAdd; }
    window.testPeers = [sender, receiver];
    sender.addTrack(output.stream.getAudioTracks()[0], output.stream);
    const toReceiver = []; const toSender = [];
    sender.onicecandidate = e => {
      if (!e.candidate) return;
      if (receiver.remoteDescription) receiver.addIceCandidate(e.candidate).catch(() => {});
      else toReceiver.push(e.candidate);
    };
    receiver.onicecandidate = e => {
      if (!e.candidate) return;
      if (sender.remoteDescription) sender.addIceCandidate(e.candidate).catch(() => {});
      else toSender.push(e.candidate);
    };
    await sender.setLocalDescription(await sender.createOffer());
    await receiver.setRemoteDescription(sender.localDescription);
    for (const candidate of toReceiver) await receiver.addIceCandidate(candidate);
    await receiver.setLocalDescription(await receiver.createAnswer());
    await sender.setRemoteDescription(receiver.localDescription);
    for (const candidate of toSender) await sender.addIceCandidate(candidate);
  };
  await page.evaluate(connectLoopback, false);
  await page.waitForFunction(() => window.testPeers.every(peer => peer.connectionState === 'connected'), null, { timeout: 10000 });
  const deadline = Date.now() + 10000;
  while (!frames.some(frame => frame.some(byte => byte !== 0)) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(frames.length > 0, 'No WebRTC PCM reached Node');
  assert(frames.every(frame => frame.length === FRAME_BYTES), 'Incorrect frame format');
  if (!frames.some(frame => frame.some(byte => byte !== 0))) {
    console.log('Audio test diagnostics:', JSON.stringify(await page.evaluate(async () => ({
      relay: window.__nektoRelay, audioState: window.testAudio.state, audioTime: window.testAudio.currentTime,
      peers: await Promise.all(window.testPeers.map(async peer => ({
        connection: peer.connectionState,
        stats: [...(await peer.getStats()).values()].filter(s => ['inbound-rtp', 'outbound-rtp', 'media-source'].includes(s.type)),
      }))),
    }))));
  }
  assert(frames.some(frame => frame.some(byte => byte !== 0)), 'Remote audio is silent');
  await page.waitForFunction(() => window.__nektoRelay.inboundPackets > 0);
  const diagnostics = await page.evaluate(() => window.__nektoRelay);
  assert.equal(diagnostics.audioState, 'running');
  assert.equal(diagnostics.peers, 2); assert.equal(diagnostics.tracks, 1);
  assert(diagnostics.trackEvents > 0); assert(diagnostics.inboundBytes > 0);
  assert(diagnostics.peerStates.every(state => state === 'connected'));
  assert.equal(diagnostics.bindingErrors, 0);
  const closeLoopback = () => {
    window.testPeers.forEach(peer => peer.close());
    window.testTone.stop(); return window.testAudio.close();
  };
  await page.evaluate(closeLoopback);
  await page.waitForFunction(() => window.__nektoRelay.tracks === 0);
  assert.equal(await page.evaluate(() => window.__nektoRelay.peers), 0);
  frames.length = 0;
  await page.evaluate(connectLoopback, true);
  await page.waitForFunction(() => window.__nektoRelay.tracks === 1);
  const recoveryDeadline = Date.now() + 10000;
  while (!frames.some(frame => frame.some(byte => byte !== 0)) && Date.now() < recoveryDeadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(frames.some(frame => frame.some(byte => byte !== 0)), 'Missed track event was not recovered');
  assert.equal(await page.evaluate(() => window.__nektoRelay.trackEvents), diagnostics.trackEvents);
  await page.evaluate(closeLoopback);
  await page.waitForFunction(() => window.__nektoRelay.tracks === 0);
  await page.evaluate(() => {
    const modal = document.createElement('div'); modal.className = 'swal2-popup';
    modal.innerHTML = '<h2 class="swal2-title">Доступ к микрофону запрещен</h2><div class="swal2-html-container">Пожалуйста разрешите доступ к микрофону.</div>';
    document.body.append(modal);
  });
  assert.equal((await page.evaluate(readAudioPrompt)).category, 'microphone-denied');
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('storage_audio_v2')); saved.settings = { theme: 'fixture-theme' };
    localStorage.setItem('storage_audio_v2', JSON.stringify(saved));
  });
  await context.close(); context = null;
  await writeTokenExtension(extensionPath, 'replacement-test-token', { matches: ['http://127.0.0.1/*'] });
  context = await chromium.launchPersistentContext(profilePath, {
    ...extensionBrowserOptions(extensionPath), executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
  });
  const replaced = await context.newPage(); await replaced.goto(origin);
  assert.equal(await replaced.evaluate(() => window.tokenAtFirstScript), 'replacement-test-token');
  assert.equal(await replaced.evaluate(() => JSON.parse(localStorage.getItem('storage_audio_v2')).settings.theme), 'fixture-theme');
  console.log('Browser integration passed: real MV3 extension at document_start; all_frames; origin scope; runtime token replacement; persistent settings; native next; restriction diagnostics; microphone; WebRTC PCM; missed track recovery; cleanup.');
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}

