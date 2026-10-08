import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { PcmQueue, FRAME_BYTES } from '../src/pcm.js';
import { TokenStore } from '../src/token-store.js';
import { installBrowserRelay } from '../src/browser-init.js';
import { searchError } from '../src/search-error.js';

test('audio queue rejects malformed frames and bounds latency', () => {
  const queue = new PcmQueue(2);
  assert.equal(queue.accept('bad'), false);
  for (const value of [1, 2, 3]) assert.equal(queue.accept(Buffer.alloc(FRAME_BYTES, value).toString('base64')), true);
  assert.equal(queue.received, 3); assert.equal(queue.dropped, 1);
  assert.equal(queue.nonSilent, 3);
  assert.equal(queue.next()[0], 2); assert.equal(queue.next()[0], 3);
  assert.deepEqual(queue.next(), Buffer.alloc(FRAME_BYTES));
});

test('token saves privately and survives process restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nekto-test-'));
  try {
    const first = new TokenStore(directory, 'fallback');
    assert.equal(await first.load(), 'fallback');
    await assert.rejects(first.set('   '));
    await first.set(' test-secret ');
    assert.equal(await new TokenStore(directory).load(), 'test-secret');
    assert.equal((await stat(first.path)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(first.path, 'utf8')).token, 'test-secret');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('token injection preserves settings and repairs malformed storage', () => {
  for (const saved of ['{"settings":{"theme":"dark"},"user":{"id":7}}', 'broken', 'null', '[]', '{"user":"bad"}']) {
    const storage = new Map([['storage_audio_v2', saved]]);
    const context = {
      location: { origin: 'https://nekto-me.kz' },
      localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
      document: { addEventListener() {} },
      AudioContext: class { constructor() { throw new Error('stop after storage injection'); } },
    };
    assert.throws(() => vm.runInNewContext(`(${installBrowserRelay.toString()})({token:'new-token',origin:'https://nekto-me.kz'})`, context));
    const result = JSON.parse(storage.get('storage_audio_v2'));
    assert.equal(result.user.authToken, 'new-token');
    if (saved.startsWith('{"settings"')) { assert.equal(result.settings.theme, 'dark'); assert.equal(result.user.id, 7); }
  }
});

test('token is never injected into third-party frames', () => {
  let wrote = false;
  vm.runInNewContext(`(${installBrowserRelay.toString()})({token:'secret',origin:'https://nekto-me.kz'})`, {
    location: { origin: 'https://other.example' }, localStorage: { setItem() { wrote = true; } },
  });
  assert.equal(wrote, false);
});

test('search diagnostics identify the failing stage without reflecting credentials', () => {
  const errors = ['load', 'control', 'click', 'confirm'].map(searchError);
  assert.equal(new Set(errors.map(error => error.code)).size, 4);
  for (const error of errors) assert(error.message.startsWith('Nekto '));
  const unknown = searchError('secret-token-value');
  assert.equal(unknown.code, 'NEKTO_SETUP');
  assert(!unknown.message.includes('secret-token-value'));
});
