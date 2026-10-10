import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { installBrowserRelay, inspectBrowserMicrophone } from '../src/browser-init.js';
import { FRAME_BYTES } from '../src/pcm.js';
import { audioClientReady, confirmAudioToken } from '../src/live-session.js';
import { readAudioPrompt } from '../src/audio-prompt.js';
import { NektoBrowser } from '../src/nekto.js';
import { writeTokenExtension, extensionBrowserOptions } from '../src/token-extension.js';
import { waitForStartControl, inspectStartControls } from '../src/start-controls.js';

import { attachNektoDiagnostics, installVerificationObserver } from '../src/network-diagnostics.js';

import { recoverRailwayProfileLock } from '../src/profile-lock.js';

import { writeSilentMicrophone } from '../src/silent-microphone.js';

import { protocolObserverScript } from '../src/protocol-diagnostics.js';

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
const silentMicrophonePath = join(directory, 'silent-microphone.wav');
let context;
try {
  await writeSilentMicrophone(silentMicrophonePath);
  await writeTokenExtension(extensionPath, 'local-test-token', { matches: ['http://127.0.0.1/*'] });
  context = await chromium.launchPersistentContext(profilePath, {
    ...extensionBrowserOptions(extensionPath, silentMicrophonePath), executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
  });
  await context.grantPermissions(['microphone'], { origin });
  const page = await context.newPage();
  const diagnosticReports = [];
  await attachNektoDiagnostics(page, 'local-test-token', { origin, log: report => diagnosticReports.push(report) });
  const frames = [];
  await page.exposeBinding('pushNektoAudio', (_, base64) => frames.push(Buffer.from(base64, 'base64')));
  await page.addInitScript({ content: `
    window.mediaAPIsBeforeRelay = {
      modern: navigator.mediaDevices.getUserMedia,
      legacy: navigator.getUserMedia,
      webkit: navigator.webkitGetUserMedia,
      moz: navigator.mozGetUserMedia,
    };
    (${installBrowserRelay.toString()})({ origin: ${JSON.stringify(origin)} });
  ` });
  await page.goto(origin);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('storage_audio_v2')).user.authToken), 'local-test-token');
  assert.equal(await page.evaluate(() => window.tokenAtFirstScript), 'local-test-token', 'Extension did not run before page scripts');
  // Native AES-GCM fixture: observers preserve ciphertext, inputs and exact Promises.
  await page.evaluate(() => {
    window.__nektoProtocolObserver.stop();
    const subtle = crypto.subtle;
    if (Object.hasOwn(subtle, 'encrypt') || Object.hasOwn(subtle, 'decrypt')) throw new Error('Observer did not restore native method descriptors');
    window.fixtureCrypto = { encrypt: subtle.encrypt, decrypt: subtle.decrypt };
    subtle.encrypt = function(...args) {
      window.fixtureCrypto.encryptArgs = args;
      const promise = Reflect.apply(window.fixtureCrypto.encrypt, this, args);
      window.fixtureCrypto.encryptPromise = promise; return promise;
    };
    subtle.decrypt = function(...args) {
      window.fixtureCrypto.decryptArgs = args;
      const promise = Reflect.apply(window.fixtureCrypto.decrypt, this, args);
      window.fixtureCrypto.decryptPromise = promise; return promise;
    };
    window.fixtureCrypto.encryptSpy = subtle.encrypt;
    window.fixtureCrypto.decryptSpy = subtle.decrypt;
  });
  await page.addScriptTag({ content: protocolObserverScript({ origin, token: 'local-test-token' }) });
  const cryptoCheck = await page.evaluate(async () => {
    const subtle = crypto.subtle, saved = window.fixtureCrypto;
    const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const algorithm = { name: 'AES-GCM', iv: new Uint8Array(12) };
    const plaintext = new TextEncoder().encode(JSON.stringify({ type: 'register', authToken: 'local-test-token' }));
    const original = plaintext.slice(), iv = algorithm.iv.slice();
    const expected = await Reflect.apply(saved.encrypt, subtle, [algorithm, key, plaintext]);
    const encryptedPromise = subtle.encrypt(algorithm, key, plaintext);
    const sameEncryptPromise = encryptedPromise === saved.encryptPromise;
    const sameArguments = saved.encryptArgs[0] === algorithm && saved.encryptArgs[1] === key && saved.encryptArgs[2] === plaintext;
    const encrypted = await encryptedPromise;
    const decryptedPromise = subtle.decrypt(algorithm, key, encrypted);
    const sameDecryptPromise = decryptedPromise === saved.decryptPromise;
    const decrypted = await decryptedPromise;
    const bytesEqual = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
    for (const body of [{ type: 'register', authToken: 'different-fixture-token' }, { type: 'scan-for-peer', token: null },
      { type: 'scan-for-peer', token: 'fixture-private-captcha' }]) {
      await subtle.encrypt(algorithm, key, new TextEncoder().encode(JSON.stringify(body)));
    }
    const encodeReply = body => Reflect.apply(saved.encrypt, subtle, [algorithm, key, new TextEncoder().encode(JSON.stringify(body))]);
    await subtle.decrypt(algorithm, key, await encodeReply({ type: 'registered', success: true }));
    const rejectedPromise = subtle.decrypt(algorithm, key, new Uint8Array([1, 2]));
    const sameRejectedPromise = rejectedPromise === saved.decryptPromise;
    let rejection;
    try { await rejectedPromise; } catch (error) { rejection = error.name; }
    await subtle.decrypt(algorithm, key, await encodeReply({ type: 'captcha-request', privateValue: 'fixture-private-response' }));
    return {
      sameEncryptPromise, sameDecryptPromise, sameRejectedPromise, sameArguments,
      ciphertextMatches: bytesEqual(new Uint8Array(expected), new Uint8Array(encrypted)),
      plaintextMatches: bytesEqual(original, new Uint8Array(decrypted)),
      inputUnchanged: bytesEqual(original, plaintext), ivUnchanged: bytesEqual(iv, algorithm.iv),
      rejection, restored: subtle.encrypt === saved.encryptSpy && subtle.decrypt === saved.decryptSpy,
    };
  });
  assert.deepEqual(cryptoCheck, { sameEncryptPromise: true, sameDecryptPromise: true, sameRejectedPromise: true,
    sameArguments: true, ciphertextMatches: true, plaintextMatches: true, inputUnchanged: true, ivUnchanged: true,
    rejection: 'OperationError', restored: true });
  for (let i = 0; i < 50 && !diagnosticReports.some(report => report.event === 'nekto_protocol' && report.type === 'captcha-request'); i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const protocolReports = diagnosticReports.filter(report => report.event === 'nekto_protocol');
  assert(protocolReports.some(report => report.type === 'register' && report.credentialMatches === true));
  assert(protocolReports.some(report => report.type === 'register' && report.credentialMatches === false));
  assert(protocolReports.some(report => report.type === 'registered' && report.success === 'true'));
  assert(protocolReports.some(report => report.type === 'scan-for-peer' && report.searchToken === 'null'));
  assert(protocolReports.some(report => report.type === 'scan-for-peer' && report.searchToken === 'present'));
  for (const secret of ['local-test-token', 'different-fixture-token', 'fixture-private-captcha', 'fixture-private-response']) {
    assert(!JSON.stringify(protocolReports).includes(secret));
  }
  await page.evaluate(() => {
    crypto.subtle.encrypt = window.fixtureCrypto.encrypt;
    crypto.subtle.decrypt = window.fixtureCrypto.decrypt;
    delete window.fixtureCrypto;
  });
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
  assert.deepEqual(await page.evaluate(() => ({
    modern: navigator.mediaDevices.getUserMedia === window.mediaAPIsBeforeRelay.modern,
    legacy: navigator.getUserMedia === window.mediaAPIsBeforeRelay.legacy,
    webkit: navigator.webkitGetUserMedia === window.mediaAPIsBeforeRelay.webkit,
    moz: navigator.mozGetUserMedia === window.mediaAPIsBeforeRelay.moz,
  })), { modern: true, legacy: true, webkit: true, moz: true }, 'Relay replaced a native microphone API');
  const silentInput = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
    } });
    const audio = new AudioContext();
    const input = audio.createMediaStreamSource(stream);
    const analyser = audio.createAnalyser(); input.connect(analyser); await audio.resume();
    let peak = 0;
    const samples = new Float32Array(analyser.fftSize);
    // Covers native startup and more than one complete WAV loop.
    for (let i = 0; i < 15; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      analyser.getFloatTimeDomainData(samples);
      for (const value of samples) peak = Math.max(peak, Math.abs(value));
    }
    const live = stream.getAudioTracks()[0].readyState === 'live';
    stream.getTracks().forEach(track => track.stop()); input.disconnect(); await audio.close();
    return { peak, live };
  });
  assert.equal(silentInput.live, true);
  assert(silentInput.peak < 0.0001, 'Native microphone contains sound');
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
  // Simulated failed resources exercise actual Playwright network listeners; no live site requests.
  await page.route('https://audio.nekto-me.kz/diagnostic-fixture**', route => route.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*' }, body: 'fixture unavailable' }));
  await page.route('https://www.google.com/recaptcha/diagnostic-fixture**', route => route.abort('failed'));
  await page.evaluate(async () => {
    await fetch('https://audio.nekto-me.kz/diagnostic-fixture?token=local-test-token').catch(() => {});
    await fetch('https://www.google.com/recaptcha/diagnostic-fixture?token=local-test-token').catch(() => {});
  });
  assert(diagnosticReports.some(report => report.event === 'nekto_http_failed' && report.target === 'audio' && report.status === 503));
  assert(diagnosticReports.some(report => report.event === 'nekto_request_failed' && report.target === 'captcha'));
  assert(!JSON.stringify(diagnosticReports).includes('local-test-token'));
  // A minimal Vuex client fixture checks the serialized functions in real Chromium.
  await page.evaluate(() => {
    const subscribers = new Set();
    const store = {
      state: { user: { authToken: JSON.parse(localStorage.getItem('storage_audio_v2')).user.authToken, tokenId: null }, system: { isFirstLoaded: true, isAuth: false, socketConnected: true } },
      commit(type, token) {
        if (type === 'user/setAuthToken') this.state.user.authToken = token;
        else if (type === 'system/socket_captcha') this.state.system.captchaRequired = token;
        else throw new Error('Wrong mutation');
        subscribers.forEach(callback => callback({ type }));
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
  await page.evaluate(installVerificationObserver, { origin });
  await page.evaluate(() => document.body.__vue__.$store.commit('system/socket_captcha', 'false'));
  await page.waitForFunction(() => document.body.__vue__.$store.state.system.captchaRequired === 'false');
  // Wait for the asynchronous binding, without changing the site's state or authorization.
  for (let i = 0; i < 50 && !diagnosticReports.some(report => report.mutation === 'system/socket_captcha'); i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert(diagnosticReports.some(report => report.mutation === 'system/socket_captcha' && report.captcha.type === 'string' && report.captcha.value === 'false'));
  assert.equal(await page.evaluate(() => document.body.__vue__.$store.state.system.captchaRequired), 'false');
  await page.evaluate(() => document.body.__vue__.$store.commit('system/socket_captcha', false));
  assert(!JSON.stringify(diagnosticReports).includes('local-test-token'));
  // Exercise /next against actual visible DOM controls without a new page or registration.
  await page.evaluate(() => {
    const store = document.body.__vue__.$store;
    store.state.chat = { activeConnectionId: 1 };
    window.nativeStarts = 0; window.nativeEnds = 0;
    const end = document.createElement('button'); end.textContent = 'Завершить разговор';
    const start = document.createElement('a'); start.href = '#/'; start.textContent = 'Әңгімелесушіні іздеу'; start.hidden = true;
    end.onclick = () => {
      window.nativeEnds++;
      const modal = document.createElement('div'); modal.className = 'swal2-popup';
      modal.textContent = 'Вы уверены, что хотите завершить разговор?';
      const yes = document.createElement('button'); yes.textContent = 'Да';
      yes.onclick = () => {
        store.state.chat.activeConnectionId = null;
        setTimeout(() => { modal.remove(); end.hidden = true; start.hidden = false; }, 100);
      };
      modal.append(yes); document.body.append(modal);
    };
    start.onclick = event => { event.preventDefault(); window.nativeStarts++; store.state.user.isSearching = true; start.hidden = true; };
    const hiddenStart = document.createElement('button'); hiddenStart.id = 'searchCompanyBtn'; hiddenStart.hidden = true;
    const hiddenCookies = document.createElement('button'); hiddenCookies.id = 'acceptCookies'; hiddenCookies.hidden = true;
    const cookies = document.createElement('button'); cookies.id = 'acceptCookies'; cookies.textContent = 'Accept cookies';
    window.nativeCookies = 0; cookies.onclick = () => { window.nativeCookies++; cookies.remove(); };
    document.body.append(hiddenStart, hiddenCookies, cookies);
    document.body.append(end, start);
  });
  const relaySession = new NektoBrowser(() => {});
  relaySession.page = page;
  relaySession.context = { close() { throw Error('Unexpected context close'); } };
  relaySession.browser = { newContext() { throw Error('Unexpected new registration'); } };
  assert.match(await relaySession.search('local-test-token'), /^Connected to a Nekto partner/);
  assert.deepEqual(await page.evaluate(() => [window.nativeStarts, window.nativeEnds]), [0, 0], 'Repeated join interrupted the partner');
  await relaySession.next('local-test-token');
  await relaySession.next('local-test-token'); // Already searching: do not click Start again.
  assert.equal(relaySession.page, page); assert.equal(relaySession.forwarding, true);
  assert.deepEqual(await page.evaluate(() => [window.nativeStarts, window.nativeEnds]), [1, 1]);
  assert.equal(await page.evaluate(() => window.nativeCookies), 0, 'Search unexpectedly accepted cookies');
  await page.evaluate(() => {
    const store = document.body.__vue__.$store;
    store.state.user.isSearching = false; store.state.chat.activeConnectionId = 2;
    document.querySelectorAll('button:not(#acceptCookies), a').forEach(control => control.remove());
    const end = document.createElement('a'); end.href = '#/'; end.textContent = 'Әңгімені аяқтау';
    const start = document.createElement('span'); start.className = 'btn'; start.innerHTML = ' <span>Начать</span>\n<span>новую беседу</span> '; start.hidden = true;
    end.onclick = event => {
      event.preventDefault(); window.nativeEnds++;
      const modal = document.createElement('div'); modal.className = 'swal2-popup';
      modal.textContent = 'Сіз әңгімені аяқтағыңыз келетініне сенімдісіз бе?';
      const yes = document.createElement('button'); yes.textContent = 'Иә';
      yes.onclick = () => {
        store.state.chat.activeConnectionId = null;
        setTimeout(() => { modal.remove(); end.hidden = true; start.hidden = false; }, 100);
      };
      modal.append(yes); document.body.append(modal);
    };
    start.onclick = () => { window.nativeStarts++; store.state.user.isSearching = true; start.hidden = true; };
    document.body.append(end, start);
  });
  assert.match(await relaySession.search('local-test-token'), /^Connected to a Nekto partner/);
  assert.deepEqual(await page.evaluate(() => [window.nativeStarts, window.nativeEnds]), [1, 1]);
  await relaySession.next('local-test-token');
  assert.deepEqual(await page.evaluate(() => [window.nativeStarts, window.nativeEnds]), [2, 2]);
  await relaySession.search('local-test-token');
  await relaySession.next('local-test-token');
  assert.deepEqual(await page.evaluate(() => [window.nativeStarts, window.nativeEnds]), [2, 2], 'Existing search was restarted');
  assert.equal(await page.evaluate(() => window.nativeCookies), 0);
  await page.evaluate(() => { document.body.__vue__.$store.state.system.forceDisconnectReason = 7; });
  await assert.rejects(relaySession.next('local-test-token'), error => error.code === 'NEKTO_RESTRICTED');
  assert.equal(relaySession.page, page); assert.equal(relaySession.forwarding, false);
  await page.evaluate(() => {
    delete document.body.__vue__.$store.state.system.forceDisconnectReason;
    document.querySelectorAll('button, a, .btn').forEach(control => control.remove());
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
  await page.evaluate(() => {
    document.body.__vue__.$store.state.user.isSearching = false;
    const missingId = document.createElement('button'); missingId.textContent = 'Начать разговор';
    missingId.onclick = () => { document.body.__vue__.$store.state.user.isSearching = true; window.nativeStarts++; };
    document.body.append(missingId);
  });
  const alternateStart = await waitForStartControl(page);
  await alternateStart.button.click();
  assert.equal(await page.evaluate(() => window.nativeStarts), 3);
  await page.evaluate(() => {
    const diagnostic = document.createElement('button'); diagnostic.id = 'fixture-diagnostic';
    diagnostic.textContent = 'local-test-token 00000000-0000-4000-8000-000000000000';
    document.body.append(diagnostic);
  });
  const controls = await inspectStartControls(page, { token: 'local-test-token' });
  assert(controls.visibleControls.some(control => control.id === 'fixture-diagnostic'));
  assert(!JSON.stringify(controls).includes('local-test-token'));
  assert(!JSON.stringify(controls).includes('00000000-0000-4000-8000-000000000000'));
  await page.evaluate(() => { document.querySelectorAll('button').forEach(button => button.remove()); });
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
  await symlink('fixture-previous-container-12345', join(profilePath, 'SingletonLock'));
  assert.equal(await recoverRailwayProfileLock(profilePath, { railwayRuntime: true, expectedDirectory: profilePath }), true);
  await writeTokenExtension(extensionPath, 'replacement-test-token', { matches: ['http://127.0.0.1/*'] });
  context = await chromium.launchPersistentContext(profilePath, {
    ...extensionBrowserOptions(extensionPath, silentMicrophonePath), executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
  });
  const replaced = await context.newPage(); await replaced.goto(origin);
  assert.equal(await replaced.evaluate(() => window.tokenAtFirstScript), 'replacement-test-token');
  assert.equal(await replaced.evaluate(() => JSON.parse(localStorage.getItem('storage_audio_v2')).settings.theme), 'fixture-theme');
  console.log('Browser integration passed: native AES-GCM ciphertext and exact Promise preservation; credential equality without secrets; native challenge observation and observer cleanup; native microphone APIs unchanged; live silent WAV capture across loops; modern and legacy permission paths; stale profile lock recovery with preserved settings; read-only Vuex flag transitions and failed HTTP/CAPTCHA request tracing; real MV3 extension at document_start; all_frames; origin scope; runtime token replacement; persistent settings; repeated join; two native next calls with Kazakh links and styled Russian controls; fading confirmation; cookie controls untouched; private diagnostics; restrictions; microphone; WebRTC PCM; missed track recovery; cleanup.');
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}

