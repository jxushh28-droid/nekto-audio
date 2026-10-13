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
  // Headless works fine against nekto — the author's production bot (edinica01/
  // cipher-chat) runs plain headless:true with real Google Chrome on a Linux server,
  // no Xvfb / no GPU tricks. The ONLY requirement is a PRE-WARMED token: warm a fresh
  // token on a real browser first (do a few chats / pass the captcha), then headless
  // uses it with no captcha. A cold token in headless searches forever and gets
  // flagged — that is the real headful-vs-headless difference, not the fingerprint.
  // So: NEKTO_HEADLESS=1 = plain headless with real Chrome + the reference's flags.
  // Force Chrome's NEW headless (--headless=new) rather than Playwright's legacy
  // headless, whose UA contains "HeadlessChrome" (nekto reads the UA). We set
  // Playwright headless:false and switch Chrome via the arg, so Playwright doesn't
  // inject the legacy flag. NEKTO_HEADLESS=legacy forces old headless for comparison.
  const wantHeadless = env.NEKTO_HEADLESS === '1';
  const legacyHeadless = env.NEKTO_HEADLESS === 'legacy';
  // Pick the hardware ANGLE backend for the OS so headless WebGL uses the REAL GPU
  // (headful shows e.g. "ANGLE (Intel ... Direct3D11)") instead of software SwiftShader.
  // A Windows platform reporting SwiftShader is nekto's VM/headless tell.
  const angle = platform === 'win32' ? 'd3d11' : platform === 'darwin' ? 'metal' : 'gl';
  return {
    channel: env.NEKTO_BROWSER_CHANNEL || (server ? 'chromium' : 'chrome'),
    headless: legacyHeadless,
    // In headless, strip Chrome's own GPU-disabling defaults so the real GPU engages.
    ignoreDefaultArgs: wantHeadless
      ? ['--mute-audio', '--disable-gpu', '--disable-gpu-compositing', '--disable-software-rasterizer']
      : ['--mute-audio'],
    args: [
      ...(platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
      ...(wantHeadless ? [
        '--headless=new', '--enable-gpu', '--ignore-gpu-blocklist',
        '--enable-webgl', '--enable-webgl2-compute-context', `--use-angle=${angle}`,
      ] : []),
      '--autoplay-policy=no-user-gesture-required',
      '--disable-blink-features=AutomationControlled',
      '--allow-running-insecure-content', '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process,Translate,MediaRouter,OptimizationHints,BackForwardCache',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-background-networking', '--disable-default-apps', '--disable-sync',
      '--disable-component-update', '--disable-breakpad', '--disable-hang-monitor',
      '--metrics-recording-only', '--no-first-run', '--no-default-browser-check',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      // Normal desktop window size; viewport:null (set per context) follows it.
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
