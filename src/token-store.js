import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class TokenStore {
  constructor(directory, fallback = '') {
    this.directory = directory;
    this.path = join(directory, 'nekto-token.json');
    this.value = fallback;
  }
  async load() {
    try {
      const stored = JSON.parse(await readFile(this.path, 'utf8'));
      if (typeof stored.token === 'string') this.value = stored.token;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Could not read the saved Nekto token.');
    }
    return this.value;
  }
  async set(token) {
    const value = token.trim();
    if (!value || value.length > 8192) throw new Error('Token must contain 1–8192 characters.');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify({ token: value }), { mode: 0o600 });
    await rename(temporary, this.path);
    this.value = value;
  }
}
