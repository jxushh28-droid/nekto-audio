import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// One second of mono PCM silence, looped by Chromium's native capture device.
export function silentMicrophoneWav() {
  const dataBytes = 48000 * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataBytes, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

export async function writeSilentMicrophone(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, silentMicrophoneWav(), { mode: 0o600 });
}
