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
  window.__nektoRelay = { tracks: 0, frames: 0, error: null };
  let pending = 0;
  const send = (buffer) => {
    if (!tracks.size || pending >= 3) return;
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    pending++;
    window.pushNektoAudio(btoa(binary))
      .then(() => { window.__nektoRelay.frames++; })
      .catch(() => {})
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
    if (track.kind !== 'audio' || tracks.has(track.id)) return;
    await ready;
    if (track.readyState === 'ended' || tracks.has(track.id)) return;
    const source = audio.createMediaStreamSource(new MediaStream([track]));
    source.connect(mix);
    tracks.set(track.id, source);
    window.__nektoRelay.tracks = tracks.size;
    track.addEventListener('ended', () => {
      source.disconnect(); tracks.delete(track.id); window.__nektoRelay.tracks = tracks.size;
    }, { once: true });
  };
  const Native = window.RTCPeerConnection;
  const RelayPeer = new Proxy(Native, {
    construct(Target, args) {
      const peer = new Target(...args);
      peer.addEventListener('track', ({ track }) => {
        capture(track).catch(() => { window.__nektoRelay.error = 'Remote audio capture failed.'; });
      });
      const cleanup = () => {
        if (!['closed', 'failed'].includes(peer.connectionState)) return;
        for (const receiver of peer.getReceivers()) {
          const source = tracks.get(receiver.track?.id);
          if (source) { source.disconnect(); tracks.delete(receiver.track.id); }
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
