import { lstat, readlink, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';

export function isProfileLockError(error) {
  return /ProcessSingleton|SingletonLock|profile appears to be in use|profile.*locked/i.test(String(error?.message || ''));
}

const processIsRunning = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
};

// Railway guarantees a single deployment mounts a service volume at a time.
// Recover only Chromium's symlink lock artifacts, after an actual lock error.
// Never remove a live local process's lock or modify profile contents.
export async function recoverRailwayProfileLock(directory, {
  railwayRuntime = !!(process.env.RAILWAY_SERVICE_ID && process.env.RAILWAY_DEPLOYMENT_ID),
  expectedDirectory = resolve(process.env.DATA_DIR || './data', 'nekto-browser'),
  localHostname = hostname(), pidIsRunning = processIsRunning,
} = {}) {
  if (!railwayRuntime || resolve(directory) !== resolve(expectedDirectory)) return false;
  const root = await lstat(directory).catch(() => null);
  if (!root?.isDirectory() || root.isSymbolicLink()) return false;
  let owner;
  try { owner = await readlink(join(directory, 'SingletonLock')); }
  catch { return false; }
  const match = /^([a-zA-Z0-9._-]{1,253})-(\d{1,10})$/.exec(owner);
  if (!match) return false;
  const pid = Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) return false;
  if (match[1] === localHostname && pidIsRunning(pid)) return false;
  const paths = ['SingletonCookie', 'SingletonSocket', 'SingletonLock'].map(name => join(directory, name));
  for (const path of paths) {
    const entry = await lstat(path).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (entry && !entry.isSymbolicLink()) return false;
  }
  // A changing lock owner means a concurrent launcher; leave everything intact.
  if (await readlink(join(directory, 'SingletonLock')).catch(() => null) !== owner) return false;
  for (const path of paths) {
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return true;
}
