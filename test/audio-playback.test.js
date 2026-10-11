import test from 'node:test';
import assert from 'node:assert/strict';
import OpusScript from 'opusscript';
import { createAudioResource, StreamType } from '@discordjs/voice';
import { PcmQueue, RelayOpusStream, FRAME_BYTES } from '../src/pcm.js';

const batch = (...values) => Buffer.concat(values.map(value => Buffer.alloc(FRAME_BYTES, value))).toString('base64');

test('an 80 ms prebuffer preserves frame order across uneven browser batches', () => {
  const queue = new PcmQueue();
  queue.accept(batch(1, 2));
  assert.equal(queue.next()[0], 0);
  assert.equal(queue.frames.length, 2, 'Prebuffer consumed early frames');
  queue.accept(batch(3, 4));
  assert.equal(queue.next()[0], 1);
  assert.equal(queue.next()[0], 2);
  queue.accept(batch(5, 6));
  for (const value of [3, 4, 5, 6]) assert.equal(queue.next()[0], value);
  assert.equal(queue.dropped, 0);
  assert.equal(queue.received, 6);
  assert.equal(queue.underruns, 0);
  assert.equal(queue.next()[0], 0);
  assert.equal(queue.underruns, 1);
});

test('an underrun refills the jitter buffer; clear cannot replay the previous partner', () => {
  const queue = new PcmQueue();
  queue.accept(batch(1, 2, 3, 4));
  for (let i = 0; i < 4; i++) queue.next();
  queue.next();
  queue.accept(batch(5, 6));
  assert.equal(queue.next()[0], 0);
  queue.accept(batch(7, 8));
  assert.equal(queue.next()[0], 5);
  queue.clear();
  assert.equal(queue.next()[0], 0);
  assert.equal(queue.frames.length, 0);
});

test('only the oldest excess audio is trimmed; malformed and oversized batches are rejected', () => {
  const queue = new PcmQueue(4);
  queue.accept(batch(1, 2, 3, 4));
  queue.accept(batch(5, 6));
  assert.equal(queue.dropped, 2);
  for (const value of [3, 4, 5, 6]) assert.equal(queue.next()[0], value);
  for (const invalid of [batch(1, 2, 3, 4, 5), Buffer.alloc(FRAME_BYTES + 1).toString('base64'), 'bad']) {
    assert.equal(queue.accept(invalid), false);
  }
});

test('Discord consumes complete Opus packets without a PCM timer or hidden transform backlog', () => {
  const queue = new PcmQueue();
  const frame = Buffer.alloc(FRAME_BYTES);
  for (let sample = 0; sample < 960; sample++) {
    const tone = Math.round(Math.sin(sample * 2 * Math.PI * 440 / 48000) * 10000);
    frame.writeInt16LE(tone, sample * 4); frame.writeInt16LE(tone, sample * 4 + 2);
  }
  queue.accept(Buffer.concat(Array(4).fill(frame)).toString('base64'));
  const stream = new RelayOpusStream(queue);
  const decoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  try {
    const resource = createAudioResource(stream, { inputType: StreamType.Opus });
    assert.equal(resource.playStream, stream);
    assert.equal(resource.edges.length, 0);
    assert.equal(stream.readableHighWaterMark, 1);
    let sound = false;
    for (let i = 0; i < 6; i++) {
      const packet = resource.read();
      assert(Buffer.isBuffer(packet));
      const decoded = decoder.decode(packet);
      assert.equal(decoded.length, FRAME_BYTES);
      sound ||= decoded.some(byte => byte !== 0);
    }
    assert.equal(sound, true, 'Opus output lost the incoming tone');
    assert.equal(queue.dropped, 0);
    assert.equal(resource.playbackDuration, 120);
  } finally { stream.destroy(); decoder.delete(); }
});
