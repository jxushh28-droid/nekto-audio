import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Deterministic per-token Windows fingerprint.
 * Same token → same fingerprint every restart. Different token → different fingerprint.
 * Uses FNV-1a 32-bit hash of the token as the PRNG seed (Xorshift32).
 */
export function generateFingerprint(token) {
  // FNV-1a 32-bit hash as seed
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // Xorshift32
  let s = h || 1;
  const rand = () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  const pick = arr => arr[Math.floor(rand() * arr.length)];

  const chromeVersions = [
    '120.0.6099.130', '121.0.6167.184', '122.0.6261.129', '123.0.6312.122',
    '124.0.6367.207', '125.0.6422.142', '126.0.6478.234', '127.0.6533.120',
    '128.0.6613.138',
  ];
  const screens = [
    [1920, 1080], [2560, 1440], [1366, 768], [1536, 864],
    [1440, 900], [1280, 720], [1600, 900],
  ];
  const memories       = [4, 8];
  const concurrencies  = [4, 8, 12, 16];
  const timezones      = ['Europe/Moscow', 'Europe/Samara', 'Europe/Volgograd',
                          'Europe/Saratov', 'Europe/Ulyanovsk', 'Europe/Kirov'];
  const languages      = ['ru-RU', 'en-US'];

  const chrome  = pick(chromeVersions);
  const [sw, sh] = pick(screens);
  const lang    = pick(languages);
  const tz      = pick(timezones);
  const mem     = pick(memories);
  const hw      = pick(concurrencies);

  return {
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`,
    platform: 'Win32',
    language: lang,
    timezone: tz,
    deviceMemory: mem,
    hardwareConcurrency: hw,
    screen: { width: sw, height: sh, availHeight: sh - 40 },
  };
}

/**
 * FNV-1a 32-bit hash of the token — used as LCG seed for canvas noise.
 * Must match the fpSeed() function in the TS source (inject.ts / NektoBrowserClient.ts).
 */
export function fpSeed(token) {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h || 1;
}

/** Builds an IIFE that overrides navigator/screen/Intl properties before the page runs. */
function fingerprintSpoofScript(fp) {
  const data = JSON.stringify(fp);
  return `(function(){
  if(typeof navigator==='undefined'||typeof screen==='undefined')return;
  var fp=${data};
  function def(obj,prop,val){try{Object.defineProperty(obj,prop,{get:function(){return val;},configurable:true});}catch(e){}}
  def(navigator,'platform',fp.platform);
  def(navigator,'userAgent',fp.userAgent);
  def(navigator,'appVersion',fp.userAgent.replace('Mozilla/',''));
  def(navigator,'language',fp.language);
  def(navigator,'languages',Object.freeze([fp.language,fp.language.split('-')[0]]));
  def(navigator,'deviceMemory',fp.deviceMemory);
  def(navigator,'hardwareConcurrency',fp.hardwareConcurrency);
  def(screen,'width',fp.screen.width);
  def(screen,'height',fp.screen.height);
  def(screen,'availWidth',fp.screen.width);
  def(screen,'availHeight',fp.screen.availHeight);
  def(screen,'colorDepth',24);
  def(screen,'pixelDepth',24);
  var NDTF=Intl.DateTimeFormat;
  var PDTF=function(l,o){o=Object.assign({},o||{});if(!o.timeZone)o.timeZone=fp.timezone;return new NDTF(l,o);};
  PDTF.supportedLocalesOf=NDTF.supportedLocalesOf.bind(NDTF);
  try{Object.defineProperty(Intl,'DateTimeFormat',{value:PDTF,configurable:true,writable:true});}catch(e){}
})();`;
}

export function tokenExtensionScript(token) {
  const fp = generateFingerprint(token);
  // fingerprintSpoofScript runs first (document_start), then the token write.
  return `${fingerprintSpoofScript(fp)}
(() => {
  const TOKEN = ${JSON.stringify(token)};
  const KEY   = "storage_audio_v2";

  const write = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || "{}") || {};
      if (saved?.user?.authToken === TOKEN) return true;
      saved.user = saved.user || {};
      saved.user.authToken = TOKEN;
      // Pre-accept cookies so nekto's Vue app never enters the captcha-triggering
      // state where WS connects before the cookie consent flag is set.
      // Nekto stores acceptance under settings.cookiesAccepted inside the same key.
      // Pre-accept cookies — nekto reads this flag from its own storage key to
      // decide whether to show the consent modal and whether the WS client is
      // "trusted". Setting it here at document_start prevents the server from
      // receiving a connection that looks like a fresh/bot session.
      saved.settings = saved.settings || {};
      saved.settings.cookiesAccepted = true;
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

export function extensionBrowserOptions(extensionPath, silentMicrophonePath, userAgent) {
  return {
    channel: 'chromium', headless: true, ignoreDefaultArgs: ['--mute-audio'],
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      // Critical: remove the single biggest bot-detection tell.
      // Without this flag navigator.webdriver === true and every anti-bot script stops here.
      '--disable-blink-features=AutomationControlled',
      ...(silentMicrophonePath ? [`--use-file-for-fake-audio-capture=${silentMicrophonePath}`] : []),
      ...(userAgent ? [`--user-agent=${userAgent}`] : []),
      `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
    ],
  };
}
