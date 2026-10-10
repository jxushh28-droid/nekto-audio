import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isProfileLockError, recoverRailwayProfileLock } from '../src/profile-lock.js';

const options = directory => ({ railwayRuntime: true, expectedDirectory: directory,
  localHostname: 'fixture-current-container', pidIsRunning: () => false });
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'profile-lock-test-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
test('only known Chromium profile lock failures trigger recovery', () => {
  assert.equal(isProfileLockError(new Error('ProcessSingleton failed')), true);
  assert.equal(isProfileLockError(new Error('The profile appears to be in use by another Chromium process')), true);
  assert.equal(isProfileLockError(new Error('Executable does not exist')), false);
});
test('Railway stale container locks are removed without altering cookies or lock targets', { skip: process.platform === 'win32' }, async () => fixture(async directory => {
  await writeFile(join(directory, 'Cookies'), 'fixture-cookie-database');
  const target = join(directory, 'socket-target'); await writeFile(target, 'fixture-socket-target');
  await symlink('fixture-previous-container-12345', join(directory, 'SingletonLock'));
  await symlink('fixture-cookie', join(directory, 'SingletonCookie'));
  await symlink(target, join(directory, 'SingletonSocket'));
  assert.equal(await recoverRailwayProfileLock(directory, options(directory)), true);
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    await assert.rejects(lstat(join(directory, name)), { code: 'ENOENT' });
  }
  assert.equal(await readFile(join(directory, 'Cookies'), 'utf8'), 'fixture-cookie-database');
  assert.equal(await readFile(target, 'utf8'), 'fixture-socket-target');
}));
test('recovery leaves active local locks, non-Railway launches and mismatched paths intact', { skip: process.platform === 'win32' }, async () => fixture(async directory => {
  const path = join(directory, 'SingletonLock');
  await symlink('fixture-current-container-12345', path);
  assert.equal(await recoverRailwayProfileLock(directory, { ...options(directory), pidIsRunning: () => true }), false);
  assert.equal(await recoverRailwayProfileLock(directory, { ...options(directory), railwayRuntime: false }), false);
  assert.equal(await recoverRailwayProfileLock(directory, { ...options(directory), expectedDirectory: join(directory, 'other') }), false);
  assert((await lstat(path)).isSymbolicLink());
}));
test('unknown lock formats, regular artifacts and symlinked profile roots are preserved', { skip: process.platform === 'win32' }, async () => fixture(async directory => {
  await symlink('invalid-owner', join(directory, 'SingletonLock'));
  assert.equal(await recoverRailwayProfileLock(directory, options(directory)), false);
  await rm(join(directory, 'SingletonLock'));
  await symlink('fixture-previous-container-12345', join(directory, 'SingletonLock'));
  await writeFile(join(directory, 'SingletonCookie'), 'fixture-unknown-regular-file');
  assert.equal(await recoverRailwayProfileLock(directory, options(directory)), false);
  const real = join(directory, 'real'); const alias = join(directory, 'alias');
  await mkdir(real); await symlink(real, alias, 'dir');
  assert.equal(await recoverRailwayProfileLock(alias, options(alias)), false);
  assert.equal(await readFile(join(directory, 'SingletonCookie'), 'utf8'), 'fixture-unknown-regular-file');
}));
