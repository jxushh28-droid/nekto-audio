import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function tokenExtensionScript(token) {
  // The uploaded prime.js, with only its hardcoded TOKEN replaced at runtime.
  return `(() => {
  const TOKEN = ${JSON.stringify(token)};
  const KEY   = "storage_audio_v2";

  const write = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || "{}") || {};
      if (saved?.user?.authToken === TOKEN) return true;
      saved.user = saved.user || {};
      saved.user.authToken = TOKEN;
      localStorage.setItem(KEY, JSON.stringify(saved));
      return true;
    } catch { return false; }
  };

  if (!write()) {
    document.addEventListener("readystatechange", write, { once: true });
  }
})();`;
}

export async function writeTokenExtension(directory, token, { matches = ['https://nekto-me.kz/*'] } = {}) {
  if (typeof token !== 'string' || token.length > 8192) throw new Error('Token must contain at most 8192 characters.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const manifest = {
    manifest_version: 3, name: 'nekto prime', version: '1.0',
    content_scripts: [{ matches, js: ['prime.js'], run_at: 'document_start', all_frames: true }],
    host_permissions: matches,
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  await writeFile(join(directory, 'prime.js'), tokenExtensionScript(token), { mode: 0o600 });
  return directory;
}

export function extensionBrowserOptions(extensionPath) {
  return {
    channel: 'chromium', headless: true, ignoreDefaultArgs: ['--mute-audio'],
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
    ],
  };
}
