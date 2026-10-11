import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commands } from '../src/commands.js';
import { RelaySettings, changeAutoNext } from '../src/relay-settings.js';
import { NektoBrowser } from '../src/nekto.js';

test('auto-next toggle persists across restarts and accepts explicit false', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-settings-'));
  const settings = new RelaySettings(directory);
  const browser = new NektoBrowser(() => {});
  const page = {}; browser.page = page;
  browser.callState = { partnerConnected: true };
  try {
    assert.equal(await settings.load(), true);
    assert.match(await changeAutoNext(browser, settings), /OFF/);
    assert.equal(browser.autoNext, false);
    assert.equal(await new RelaySettings(directory).load(), false);
    assert.match(await changeAutoNext(browser, settings, false), /OFF/);
    assert.equal(browser.page, page);
    assert.equal(browser.callState.partnerConnected, true);
    assert.match(await changeAutoNext(browser, settings), /ON/);
    assert.equal(await new RelaySettings(directory).load(), true);
    assert.deepEqual(JSON.parse(await readFile(settings.path, 'utf8')), { autoNext: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a failed save restores the current setting without changing a call', async () => {
  const browser = new NektoBrowser(() => {});
  await assert.rejects(changeAutoNext(browser, { setAutoNext: async () => { throw Error('disk unavailable'); } }), /Could not save/);
  assert.equal(browser.autoNext, true);
});

test('invalid saved settings cannot silently re-enable automatic next', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-settings-invalid-'));
  try {
    const settings = new RelaySettings(directory);
    await writeFile(settings.path, JSON.stringify({ autoNext: 'false' }));
    await assert.rejects(settings.load(), /Could not read/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('auto-next registers as an optional boolean slash command', () => {
  const command = commands.find(command => command.name === 'autonext');
  assert.equal(command.dm_permission, false);
  assert.equal(command.options[0].name, 'enabled');
  assert.equal(command.options[0].type, 5);
  assert.equal(command.options[0].required, false);
  assert.equal(new Set(commands.map(command => command.name)).size, commands.length);
});
