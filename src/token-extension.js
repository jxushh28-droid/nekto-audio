import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Match the token-only extension: update storage before Vuex initializes, and
// leave the browser's fingerprint, consent and other saved settings intact.
export function tokenExtensionScript(token, { origins = ['https://nekto-me.kz'] } = {}) {
  if (typeof token !== 'string' || token.length > 8192) throw new Error('Token must contain at most 8192 characters.');
  return `(() => {
  if (!${JSON.stringify(origins)}.includes(location.origin)) return;
  const TOKEN = ${JSON.stringify(token)};
  const KEY = "storage_audio_v2";
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
  if (!write()) document.addEventListener("readystatechange", write, { once: true });
})();`;
}

export async function writeTokenExtension(directory, token, {
  matches = ['https://nekto-me.kz/*'], origins = ['https://nekto-me.kz'],
} = {}) {
  const code = tokenExtensionScript(token, { origins });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const manifest = {
    manifest_version: 3, name: 'nekto prime', version: '1.0',
    content_scripts: [{ matches, js: ['prime.js'], run_at: 'document_start', all_frames: true }],
    host_permissions: matches,
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  await writeFile(join(directory, 'prime.js'), code, { mode: 0o600 });
  return directory;
}

export function browserLaunchOptions(silentMicrophonePath, { env = process.env, platform = process.platform } = {}) {
  if (typeof silentMicrophonePath !== 'string' || !silentMicrophonePath) throw new Error('A silent microphone file is required.');
  const server = !!env.RAILWAY_PROJECT_ID ||
    (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY);
  // The hard truth: nekto detects BOTH the headless render path AND any JS tampering
  // used to hide it (it native-checks canvas/WebGL/etc. and compares against a clean
  // iframe). So no headless mode and no JS fingerprint spoof survives — only a REAL,
  // untampered headful browser passes. To run with nothing visible on screen, we run
  // that real headful browser but park its window far OFF-SCREEN. It is byte-for-byte
  // the headful browser that works; the window simply never appears on any monitor.
  //   default               → headful, visible window
  //   NEKTO_HEADLESS=1       → headful, window off-screen (nothing visible, works)
  //   NEKTO_HEADLESS=gpu     → new headless + real GPU (no window, but nekto detects it)
  //   NEKTO_HEADLESS=legacy  → old headless (debug; detected)
  const mode = env.NEKTO_HEADLESS;
  const offscreen = mode === '1';
  const gpuHeadless = mode === 'gpu' || mode === 'new';
  const legacyHeadless = mode === 'legacy';
  return {
    channel: env.NEKTO_BROWSER_CHANNEL || (server ? 'chromium' : 'chrome'),
    headless: legacyHeadless,
    ignoreDefaultArgs: gpuHeadless
      ? ['--mute-audio', '--disable-gpu', '--disable-gpu-compositing', '--disable-software-rasterizer']
      : ['--mute-audio'],
    args: [
      ...(platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
      ...(gpuHeadless ? [
        '--headless=new', '--enable-gpu', '--ignore-gpu-blocklist',
        ...(platform === 'win32' ? ['--use-angle=d3d11']
          : platform === 'darwin' ? ['--use-angle=metal'] : ['--use-angle=gl']),
      ] : []),
      // Off-screen headful: a real window parked far off every monitor (invisible),
      // with the taskbar entry suppressed where possible.
      ...(offscreen ? ['--window-position=-32000,-32000'] : []),
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      // Normal desktop window size; viewport:null (set per context) follows it.
      // Override with NEKTO_WINDOW_SIZE=WxH.
      `--window-size=${(env.NEKTO_WINDOW_SIZE || '1920,1080').replace(/x/i, ',')}`,
      `--use-file-for-fake-audio-capture=${silentMicrophonePath}`,
    ],
  };
}

// Used by the local extension integration fixture.
export function extensionBrowserOptions(extensionPath, silentMicrophonePath) {
  const options = browserLaunchOptions(silentMicrophonePath);
  return {
    ...options, channel: 'chromium', headless: true, ignoreDefaultArgs: ['--mute-audio', '--disable-extensions'],
    args: [...options.args,
      `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  };
}
