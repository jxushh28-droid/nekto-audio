import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { installBrowserRelay } from '../src/browser-init.js';
import { FRAME_BYTES } from '../src/pcm.js';
import { audioClientReady, confirmAudioToken } from '../src/live-session.js';

// Local-only integration test: real Chromium/WebRTC/WebAudio, no Nekto call or Discord login.
const server = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><title>Relay test</title>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH, ignoreDefaultArgs: ['--mute-audio'], args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const frames = [];
  await page.exposeBinding('pushNektoAudio', (_, base64) => frames.push(Buffer.from(base64, 'base64')));
  await page.addInitScript(installBrowserRelay, { token: 'local-test-token', origin });
  await page.goto(origin);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('storage_audio_v2')).user.authToken), 'local-test-token');
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
  console.log('Browser integration passed: WebRTC -> 48 kHz stereo PCM; missed track event recovery; peer diagnostics; native audio registration; cleanup.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}

