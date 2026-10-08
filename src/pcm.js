import { Readable } from 'node:stream';

export const FRAME_BYTES = 960 * 2 * 2; // 20 ms, 48 kHz, stereo, signed 16-bit LE.

export class PcmQueue {
  frames = [];
  received = 0;
  nonSilent = 0;
  dropped = 0;
  constructor(maxFrames = 6) { this.maxFrames = maxFrames; }
  accept(base64) {
    if (typeof base64 !== 'string' || base64.length !== FRAME_BYTES / 3 * 4) return false;
    const frame = Buffer.from(base64, 'base64');
    if (frame.length !== FRAME_BYTES) return false;
    this.received++;
    if (frame.some(byte => byte !== 0)) this.nonSilent++;
    if (this.frames.length >= this.maxFrames) { this.frames.shift(); this.dropped++; }
    this.frames.push(frame);
    return true;
  }
  next() { return this.frames.shift() ?? Buffer.alloc(FRAME_BYTES); }
  clear() { this.frames.length = 0; }
}

export class PcmStream extends Readable {
  constructor(queue) {
    super({ highWaterMark: FRAME_BYTES * 3 });
    this.timer = setInterval(() => {
      if (this.readableLength < FRAME_BYTES * 3) this.push(queue.next());
      else queue.clear();
    }, 20);
  }
  _read() {}
  _destroy(error, done) { clearInterval(this.timer); done(error); }
}
