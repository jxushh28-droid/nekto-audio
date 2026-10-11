import { Readable } from 'node:stream';
import OpusScript from 'opusscript';

export const FRAME_BYTES = 960 * 2 * 2; // 20 ms, 48 kHz, stereo, signed 16-bit LE.
const SILENCE = Buffer.alloc(FRAME_BYTES);

export class PcmQueue {
  frames = [];
  received = 0;
  nonSilent = 0;
  dropped = 0;
  underruns = 0;
  primed = false;
  constructor(maxFrames = 12, { prebufferFrames = 4 } = {}) {
    this.maxFrames = maxFrames;
    this.prebufferFrames = Math.min(maxFrames, prebufferFrames);
  }
  accept(base64) {
    if (typeof base64 !== 'string' || base64.length < FRAME_BYTES / 3 * 4 ||
        base64.length > FRAME_BYTES / 3 * 4 * 4) return false;
    const batch = Buffer.from(base64, 'base64');
    if (batch.length % FRAME_BYTES || batch.length < FRAME_BYTES || batch.length > FRAME_BYTES * 4) return false;
    for (let offset = 0; offset < batch.length; offset += FRAME_BYTES) {
      const frame = batch.subarray(offset, offset + FRAME_BYTES);
      this.received++;
      if (frame.some(byte => byte !== 0)) this.nonSilent++;
      if (this.frames.length >= this.maxFrames) { this.frames.shift(); this.dropped++; }
      this.frames.push(frame);
    }
    return true;
  }
  next() {
    // Hold 80 ms before playing so uneven browser delivery does not insert gaps.
    if (!this.primed) {
      if (this.frames.length < this.prebufferFrames) return SILENCE;
      this.primed = true;
    }
    if (!this.frames.length) {
      this.underruns++;
      this.primed = false;
      return SILENCE;
    }
    return this.frames.shift();
  }
  clear() { this.frames.length = 0; this.primed = false; }
}

export class RelayOpusStream extends Readable {
  constructor(queue, { bitrate = 64000 } = {}) {
    // Discord reads one packet each 20 ms. Avoid a second drifting timer and
    // the raw PCM transform's large packet backlog; keep just one packet ahead.
    super({ objectMode: true, highWaterMark: 1 });
    this.queue = queue;
    this.encoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
    this.encoder.setBitrate(Math.max(16000, Math.min(96000, bitrate)));
    this.encoder.encoderCTL(4012, 1); // Opus in-band forward error correction.
    this.encoder.encoderCTL(4014, 10); // Allow for up to 10% outbound packet loss.
  }
  _read() {
    try { this.push(this.encoder.encode(this.queue.next(), 960)); }
    catch (error) { this.destroy(error); }
  }
  _destroy(error, done) {
    this.encoder?.delete();
    this.encoder = null;
    done(error);
  }
}
