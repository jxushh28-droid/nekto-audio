import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tokenExtensionScript, writeTokenExtension } from '../src/token-extension.js';

test('extension preserves existing settings and skips an already matching token', () => {
  let saved = JSON.stringify({ settings: { theme: 'dark' }, user: { authToken: 'old', openChats: 6 } }), writes = 0;
  const context = { localStorage: { getItem: () => saved, setItem: (_, value) => { writes++; saved = value; } },
    document: { addEventListener() { throw Error('Unexpected retry'); } } };
  vm.runInNewContext(tokenExtensionScript('next-token'), context);
  assert.deepEqual(JSON.parse(saved), { settings: { theme: 'dark' }, user: { authToken: 'next-token', openChats: 6 } });
  vm.runInNewContext(tokenExtensionScript('next-token'), context);
  assert.equal(writes, 1);
});

test('extension retains the uploaded readystatechange retry and safely quotes runtime tokens', () => {
  let saved = 'broken', retry;
  const token = 'fixture";globalThis.executed=true;\\\n';
  const context = { localStorage: { getItem: () => saved, setItem: (_, value) => { saved = value; } },
    document: { addEventListener(name, callback, options) {
      assert.equal(name, 'readystatechange'); assert.equal(options.once, true); retry = callback;
    } } };
  vm.runInNewContext(tokenExtensionScript(token), context);
  assert.equal(typeof retry, 'function'); saved = '{}'; retry();
  assert.equal(JSON.parse(saved).user.authToken, token); assert.equal(context.executed, undefined);
});

test('generated extension matches the uploaded manifest and updates tokens in private files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'prime-extension-'));
  try {
    await writeTokenExtension(directory, 'first-fixture');
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest, { manifest_version: 3, name: 'nekto prime', version: '1.0',
      content_scripts: [{ matches: ['https://nekto-me.kz/*'], js: ['prime.js'], run_at: 'document_start', all_frames: true }],
      host_permissions: ['https://nekto-me.kz/*'] });
    await writeTokenExtension(directory, 'second-fixture');
    const code = await readFile(join(directory, 'prime.js'), 'utf8');
    assert(!code.includes('first-fixture')); assert(code.includes('second-fixture'));
    assert.equal((await stat(join(directory, 'prime.js'))).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
