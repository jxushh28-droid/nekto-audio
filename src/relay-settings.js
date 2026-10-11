import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class RelaySettings {
  constructor(directory) {
    this.directory = directory;
    this.path = join(directory, 'relay-settings.json');
    this.autoNext = true;
  }
  async load() {
    try {
      const stored = JSON.parse(await readFile(this.path, 'utf8'));
      if (typeof stored.autoNext !== 'boolean') throw new Error('Invalid setting.');
      this.autoNext = stored.autoNext;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Could not read the saved relay settings.');
    }
    return this.autoNext;
  }
  async setAutoNext(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Auto-next must be enabled or disabled.');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify({ autoNext: enabled }), { mode: 0o600 });
    await rename(temporary, this.path);
    this.autoNext = enabled;
  }
}

export async function changeAutoNext(browser, settings, enabled = null) {
  const previous = browser.autoNext;
  const next = enabled ?? !previous;
  browser.setAutoNext(next);
  try { await settings.setAutoNext(next); }
  catch {
    browser.setAutoNext(previous);
    throw new Error('Could not save the auto-next setting.');
  }
  return next ? 'Automatic next is ON. Search resumes when a partner ends the call.' :
    'Automatic next is OFF. Use /next after a partner ends the call.';
}
