import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentMicrophoneWav, writeSilentMicrophone } from '../src/silent-microphone.js';
import { extensionBrowserOptions } from '../src/token-extension.js';

test('silent microphone WAV has valid mono 48kHz PCM headers and no audio samples', () => {
  const wav = silentMicrophoneWav();
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 48000);
  assert.equal(wav.readUInt32LE(28), 96000);
  assert.equal(wav.readUInt16LE(32), 2);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), 96000);
  assert(wav.subarray(44).every(value => value === 0));
});

test('native microphone uses a private silent WAV outside extension contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'silent-microphone-'));
  try {
    const path = join(directory, 'silent-microphone.wav');
    await writeSilentMicrophone(path);
    assert.deepEqual(await readFile(path), silentMicrophoneWav());
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
    const options = extensionBrowserOptions(join(directory, 'extension'), path);
    assert(options.args.includes('--use-file-for-fake-audio-capture=' + path));
    assert(options.args.includes('--use-fake-device-for-media-stream'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
