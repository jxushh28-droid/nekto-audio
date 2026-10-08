import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { installBrowserRelay } from '../src/browser-init.js';
import { FRAME_BYTES } from '../src/pcm.js';

// Local-only integration test: real Chromium/WebRTC/WebAudio, no Nekto call or Discord login.
const server = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><title>Relay test</title>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const frames = [];
  await page.exposeBinding('pushNektoAudio', (_, base64) => frames.push(Buffer.from(base64, 'base64')));
  await page.addInitScript(installBrowserRelay, { token: 'local-test-token', origin });
  await page.goto(origin);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('storage_audio_v2')).user.authToken), 'local-test-token');
  await page.evaluate(async () => {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (mic.getAudioTracks().length !== 1) throw new Error('Silent microphone missing');
    const audio = new AudioContext({ sampleRate: 48000 });
    const source = audio.createOscillator(); source.frequency.value = 440;
    const output = audio.createMediaStreamDestination(); source.connect(output); source.start(); await audio.resume();
    const sender = new RTCPeerConnection({ iceServers: [] });
    const receiver = new RTCPeerConnection({ iceServers: [] });
    window.testPeers = [sender, receiver];
    sender.addTrack(output.stream.getAudioTracks()[0], output.stream);
    sender.onicecandidate = e => { if (e.candidate) receiver.addIceCandidate(e.candidate).catch(() => {}); };
    receiver.onicecandidate = e => { if (e.candidate) sender.addIceCandidate(e.candidate).catch(() => {}); };
    await sender.setLocalDescription(await sender.createOffer());
    await receiver.setRemoteDescription(sender.localDescription);
    await receiver.setLocalDescription(await receiver.createAnswer());
    await sender.setRemoteDescription(receiver.localDescription);
  });
  const deadline = Date.now() + 10000;
  while (!frames.some(frame => frame.some(byte => byte !== 0)) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(frames.length > 0, 'No WebRTC PCM reached Node');
  assert(frames.every(frame => frame.length === FRAME_BYTES), 'Incorrect frame format');
  assert(frames.some(frame => frame.some(byte => byte !== 0)), 'Remote audio is silent');
  await page.evaluate(() => window.testPeers.forEach(peer => peer.close()));
  await page.waitForFunction(() => window.__nektoRelay.tracks === 0);
  console.log('Browser integration passed: real WebRTC audio -> 48 kHz stereo PCM; token injection; silent mic; cleanup.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
