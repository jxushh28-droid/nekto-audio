// Serialized by Playwright and run before the site's scripts.
export function installBrowserRelay({ token, origin }) {
  if (location.origin !== origin) return;
  const KEY = 'storage_audio_v2';
  const write = () => {
    try {
      let saved;
      try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { saved = {}; }
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
      if (!saved.user || typeof saved.user !== 'object' || Array.isArray(saved.user)) saved.user = {};
      saved.user.authToken = token;
      localStorage.setItem(KEY, JSON.stringify(saved));
      return true;
    } catch { return false; }
  };
  if (!write()) document.addEventListener('readystatechange', write, { once: true });

  const audio = new AudioContext({ sampleRate: 48000 });
  const mix = audio.createGain();
  const tracks = new Map();
  const peers = new Set();
  const pendingTracks = new Set();
  window.__nektoRelay = { tracks: 0, trackEvents: 0, frames: 0, error: null, bindingErrors: 0,
    peers: 0, peerStates: [], iceStates: [], inboundPackets: 0, inboundBytes: 0, audioState: audio.state };
  audio.addEventListener('statechange', () => { window.__nektoRelay.audioState = audio.state; });
  let pending = 0;
  const send = (buffer) => {
    if (!tracks.size || pending >= 3) return;
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    pending++;
    window.pushNektoAudio(btoa(binary))
      .then(() => { window.__nektoRelay.frames++; })
      .catch(() => { window.__nektoRelay.bindingErrors++; })
      .finally(() => { pending--; });
  };
  const processorCode = `
    class Relay extends AudioWorkletProcessor {
      constructor() { super(); this.frame = new ArrayBuffer(3840); this.view = new DataView(this.frame); this.offset = 0; }
      process(inputs) {
        const channels = inputs[0];
        if (!channels?.[0]) return true;
        const left = channels[0]; const right = channels[1] || left;
        for (let i = 0; i < left.length; i++) {
          const l = Math.max(-1, Math.min(1, left[i]));
          const r = Math.max(-1, Math.min(1, right[i]));
          this.view.setInt16(this.offset, Math.round(l * (l < 0 ? 32768 : 32767)), true);
          this.view.setInt16(this.offset + 2, Math.round(r * (r < 0 ? 32768 : 32767)), true);
          this.offset += 4;
          if (this.offset === 3840) {
            this.port.postMessage(this.frame, [this.frame]);
            this.frame = new ArrayBuffer(3840); this.view = new DataView(this.frame); this.offset = 0;
          }
        }
        return true;
      }
    }
    registerProcessor('nekto-relay', Relay);`;
  const ready = (async () => {
    const url = URL.createObjectURL(new Blob([processorCode], { type: 'application/javascript' }));
    try { await audio.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    const processor = new AudioWorkletNode(audio, 'nekto-relay', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    });
    processor.port.onmessage = ({ data }) => send(data);
    mix.connect(processor);
    processor.connect(audio.destination); // Worklet output is silence; keeps the graph rendering.
    await audio.resume();
  })();
  ready.catch(() => { window.__nektoRelay.error = 'Audio capture initialization failed.'; });

  // The requested relay is incoming only. Supply a silent microphone to Nekto.
  const silentMic = audio.createMediaStreamDestination();
  const oscillator = audio.createOscillator();
  const mute = audio.createGain(); mute.gain.value = 0;
  oscillator.connect(mute); mute.connect(silentMic); oscillator.start();
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (constraints?.video || !constraints?.audio) throw new DOMException('Audio only', 'NotSupportedError');
    await audio.resume();
    return silentMic.stream.clone();
  };
  const capture = async (track) => {
    if (track.kind !== 'audio' || tracks.has(track.id) || pendingTracks.has(track.id)) return;
    pendingTracks.add(track.id);
    let playback, source;
    try {
      await ready; await audio.resume();
      if (track.readyState === 'ended' || tracks.has(track.id)) return;
      const stream = new MediaStream([track]);
      // Chromium's WebRTC jitter buffer needs an active media-element sink to start playout.
      playback = document.createElement('audio');
      playback.srcObject = stream;
      playback.autoplay = true;
      await playback.play();
      if (track.readyState === 'ended') { playback.pause(); playback.srcObject = null; return; }
      source = audio.createMediaStreamSource(stream);
      source.connect(mix);
      tracks.set(track.id, { source, playback });
      window.__nektoRelay.tracks = tracks.size;
      track.addEventListener('ended', () => {
        source.disconnect(); playback.pause(); playback.srcObject = null;
        tracks.delete(track.id); window.__nektoRelay.tracks = tracks.size;
      }, { once: true });
    } catch (error) {
      source?.disconnect(); playback?.pause();
      if (playback) playback.srcObject = null;
      throw error;
    } finally { pendingTracks.delete(track.id); }
  };
  const recoverTracks = peer => {
    if (peer.connectionState !== 'connected') return;
    for (const transceiver of peer.getTransceivers()) {
      if (!['sendrecv', 'recvonly'].includes(transceiver.currentDirection)) continue;
      const track = transceiver.receiver?.track;
      if (track) capture(track).catch(() => { window.__nektoRelay.error = 'Remote audio capture failed.'; });
    }
  };
  let sampling = false;
  const diagnosticsTimer = setInterval(async () => {
    if (sampling) return;
    sampling = true;
    try {
      const current = [...peers];
      window.__nektoRelay.peers = current.length;
      window.__nektoRelay.peerStates = current.map(peer => peer.connectionState);
      window.__nektoRelay.iceStates = current.map(peer => peer.iceConnectionState);
      let packets = 0, bytes = 0;
      for (const peer of current) {
        recoverTracks(peer);
        const stats = await peer.getStats().catch(() => null);
        for (const entry of stats?.values() || []) {
          if (entry.type === 'inbound-rtp' && (entry.kind === 'audio' || entry.mediaType === 'audio')) {
            packets += entry.packetsReceived || 0; bytes += entry.bytesReceived || 0;
          }
        }
      }
      window.__nektoRelay.inboundPackets = packets; window.__nektoRelay.inboundBytes = bytes;
    } catch {} finally { sampling = false; }
  }, 1000);
  window.addEventListener('pagehide', () => clearInterval(diagnosticsTimer), { once: true });
  const Native = window.RTCPeerConnection;
  const RelayPeer = new Proxy(Native, {
    construct(Target, args) {
      const peer = new Target(...args);
      peers.add(peer);
      window.__nektoRelay.peers = peers.size;
      peer.addEventListener('track', ({ track }) => {
        if (track.kind === 'audio') window.__nektoRelay.trackEvents++;
        capture(track).catch(() => { window.__nektoRelay.error = 'Remote audio capture failed.'; });
      });
      const cleanup = () => {
        recoverTracks(peer);
        if (!['closed', 'failed'].includes(peer.connectionState)) return;
        if (peer.connectionState === 'closed') peers.delete(peer);
        window.__nektoRelay.peers = peers.size;
        for (const receiver of peer.getReceivers()) {
          const captured = tracks.get(receiver.track?.id);
          if (captured) {
            captured.source.disconnect(); captured.playback.pause(); captured.playback.srcObject = null;
            tracks.delete(receiver.track.id);
          }
        }
        window.__nektoRelay.tracks = tracks.size;
      };
      peer.addEventListener('connectionstatechange', cleanup);
      const close = peer.close.bind(peer);
      peer.close = () => { close(); cleanup(); };
      return peer;
    },
  });
  window.RTCPeerConnection = RelayPeer;
  if (window.webkitRTCPeerConnection === Native) window.webkitRTCPeerConnection = RelayPeer;
}

