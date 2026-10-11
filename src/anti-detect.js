/**
 * Anti-detection init script — serialized by Playwright and injected via page.addInitScript().
 * Runs in the browser before any site JS. Never references Node APIs.
 *
 * Receives: { fptHash: string (md5 of token), fpSeed: number (FNV-1a of token) }
 *
 * Bypasses:
 *  1. FPT hash        — hook crypto.subtle.encrypt → replace obj.fpt with per-token md5
 *  2. WebGL GPU       — NVIDIA RTX 3060 D3D11 instead of SwiftShader (Linux giveaway)
 *  3. Canvas 2D noise — per-token LCG pixel perturbation → breaks cross-slot fingerprint
 *  4. WebGPU          — fake NVIDIA Ampere adapter info
 *  5. userAgentData   — platform = "Windows" (Client Hints complement)
 *  6. Cookie banner + tab-conflict auto-click
 */
export function installAntiDetect({ fptHash, fpSeed, gumHash }) {

  // ── 0. navigator.webdriver — the #1 bot detection signal ───────────────────
  // Playwright (like Puppeteer) sets navigator.webdriver = true unless the
  // --disable-blink-features=AutomationControlled flag is passed AND the JS
  // property is explicitly removed. We do both: the flag is set in
  // extensionBrowserOptions(); this override removes the JS-level property so
  // runtime checks (typeof navigator.webdriver, navigator.webdriver === true)
  // return undefined rather than true.
  try {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
      enumerable: true,
    });
  } catch (_) {}

  // ── 0b. navigator.plugins + chrome object ──────────────────────────────────
  // Headless Chrome: navigator.plugins.length === 0 (dead giveaway).
  // Real Chrome: 3 plugins (PDF Viewer, Chrome PDF Viewer, Native Client).
  // Also ensure window.chrome exists (headless sometimes lacks it).
  try {
    const makeFakePlugin = (name, filename, description) => {
      const mime = { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description };
      const plugin = Object.create(Plugin.prototype);
      Object.defineProperty(plugin, 'name', { get: () => name });
      Object.defineProperty(plugin, 'filename', { get: () => filename });
      Object.defineProperty(plugin, 'description', { get: () => description });
      Object.defineProperty(plugin, 'length', { get: () => 1 });
      plugin[0] = mime;
      return plugin;
    };
    const fakePlugins = [
      makeFakePlugin('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      makeFakePlugin('Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      makeFakePlugin('Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      makeFakePlugin('Microsoft Edge PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      makeFakePlugin('WebKit built-in PDF', 'internal-pdf-viewer', 'Portable Document Format'),
    ];
    const fakePluginArray = Object.create(PluginArray.prototype);
    fakePlugins.forEach((p, i) => { fakePluginArray[i] = p; });
    Object.defineProperty(fakePluginArray, 'length', { get: () => fakePlugins.length });
    fakePluginArray.item = (i) => fakePlugins[i];
    fakePluginArray.namedItem = (n) => fakePlugins.find(p => p.name === n) || null;
    fakePluginArray.refresh = () => {};
    Object.defineProperty(navigator, 'plugins', { get: () => fakePluginArray, configurable: true });
  } catch (_) {}

  // Ensure window.chrome is present (headless sometimes skips it).
  try {
    if (!window.chrome) {
      Object.defineProperty(window, 'chrome', {
        get: () => ({ runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} }),
        configurable: true,
      });
    }
  } catch (_) {}

  // ── 1. FPT spoof (WebCrypto encrypt hook) ──────────────────────────────────
  // Ported verbatim from the proven reference (inject.ts). nekto encrypts every
  // outgoing WS frame with crypto.subtle.encrypt (AES-GCM). We intercept, and if
  // the plaintext carries an `fpt` field (FingerprintJS visitorId) we swap it for
  // md5(token).
  //
  // WHY: nekto hangs a shadow/phantom ban on the DEVICE (fpt), not the token. The
  // machine's real visitorId is stable across token changes (our fingerprint spoof
  // is deterministic), so a new token on the same machine reuses the same real fpt
  // and inherits the flagged device → captcha on every new token. md5(token) gives
  // each token its own stable device identity, so bans never carry across tokens.
  //
  // Applied UNIFORMLY to all messages (register, set-fpt, scan-for-peer) so the fpt
  // is internally consistent. We do NOT touch anything else (gumHash, canvas,
  // plugins, duration, deviceInfo) — the reference leaves them intact and works;
  // stripping fields the server expects is itself a bot tell.
  if (fptHash && typeof crypto !== 'undefined' && crypto.subtle) {
    const _enc = crypto.subtle.encrypt.bind(crypto.subtle);
    const td = new TextDecoder();
    const patched = async function(algo, key, data) {
      let out = data;
      try {
        let buf;
        if (data instanceof ArrayBuffer) buf = data;
        else if (ArrayBuffer.isView(data)) buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        if (buf) {
          const obj = JSON.parse(td.decode(buf));
          if (obj && typeof obj.fpt === 'string' && obj.fpt !== fptHash) {
            obj.fpt = fptHash;
            out = new TextEncoder().encode(JSON.stringify(obj));
          }
        }
      } catch (_) {}
      return _enc(algo, key, out);
    };
    try {
      Object.defineProperty(crypto.subtle, 'encrypt', {
        value: patched, writable: true, configurable: true, enumerable: true,
      });
    } catch (_) {}
  }

  // ── 2. WebGL GPU spoof ──────────────────────────────────────────────────────
  const GL_VENDOR          = 0x1F00;
  const GL_RENDERER        = 0x1F01;
  const UNMASKED_VENDOR    = 0x9245;
  const UNMASKED_RENDERER  = 0x9246;
  const SPOOFED_VENDOR     = 'Google Inc. (NVIDIA)';
  const SPOOFED_RENDERER   = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)';
  const BASIC_VENDOR       = 'Google Inc.';
  const BASIC_RENDERER     = 'ANGLE (NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)';

  function patchWebGLProto(proto) {
    if (!proto) return;
    try {
      const orig = proto.getParameter;
      proto.getParameter = function(param) {
        if (param === UNMASKED_VENDOR)   return SPOOFED_VENDOR;
        if (param === UNMASKED_RENDERER) return SPOOFED_RENDERER;
        if (param === GL_VENDOR)         return BASIC_VENDOR;
        if (param === GL_RENDERER)       return BASIC_RENDERER;
        return orig.call(this, param);
      };
    } catch (_) {}
  }

  try { patchWebGLProto(typeof WebGLRenderingContext  !== 'undefined' ? WebGLRenderingContext.prototype  : null); } catch (_) {}
  try { patchWebGLProto(typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext.prototype : null); } catch (_) {}

  // ── 3. Canvas 2D per-token noise ────────────────────────────────────────────
  // LCG PRNG seeded from fpSeed. Same token → same noise (stable); different tokens
  // → different noise (breaks cross-slot FingerprintJS correlation).
  // Perturbation: ±1 on red channel per pixel — invisible but kills exact hash match.
  try {
    const seed = (fpSeed >>> 0) || 1;

    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function(sx, sy, sw, sh, settings) {
      const id = origGetImageData.call(this, sx, sy, sw, sh, settings);
      let s = seed;
      for (let i = 0; i < id.data.length; i += 4) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        id.data[i] = (id.data[i] + (s >>> 24 & 1)) & 0xff; // red channel ±1
      }
      return id;
    };

    // toDataURL may bypass getImageData; bake noise in first.
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(...args) {
      try {
        const ctx2d = this.getContext('2d');
        if (ctx2d && this.width > 0 && this.height > 0) {
          const imgData = ctx2d.getImageData(0, 0, this.width, this.height); // calls patched version
          ctx2d.putImageData(imgData, 0, 0);
        }
      } catch (_) {}
      return origToDataURL.apply(this, args);
    };

    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function(cb, ...args) {
      try {
        const ctx2d = this.getContext('2d');
        if (ctx2d && this.width > 0 && this.height > 0) {
          const imgData = ctx2d.getImageData(0, 0, this.width, this.height);
          ctx2d.putImageData(imgData, 0, 0);
        }
      } catch (_) {}
      return origToBlob.call(this, cb, ...args);
    };
  } catch (_) {}

  // ── 4. WebGPU adapter info ──────────────────────────────────────────────────
  try {
    if (typeof navigator !== 'undefined' && navigator.gpu) {
      const _origReqAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
      navigator.gpu.requestAdapter = async function(options) {
        const adapter = await _origReqAdapter(options);
        if (!adapter) return adapter;
        if (typeof adapter.requestAdapterInfo === 'function') {
          const _origInfo = adapter.requestAdapterInfo.bind(adapter);
          adapter.requestAdapterInfo = async function() {
            const info = await _origInfo();
            try {
              return {
                vendor: 'nvidia', architecture: 'ampere',
                device: '', description: 'NVIDIA GeForce RTX 3060',
              };
            } catch (_) { return info; }
          };
        }
        return adapter;
      };
    }
  } catch (_) {}

  // ── 5. userAgentData / Client Hints ─────────────────────────────────────────
  // Complement to the --user-agent Chromium flag + navigator.platform override.
  // Prevents navigator.userAgentData.platform from leaking "Linux".
  try {
    if (typeof navigator !== 'undefined' && navigator.userAgentData) {
      const _orig = navigator.userAgentData;
      const _patched = Object.create(_orig);
      Object.defineProperty(_patched, 'platform', { get: () => 'Windows', configurable: true, enumerable: true });
      // getHighEntropyValues: patch platform in result
      if (typeof _orig.getHighEntropyValues === 'function') {
        const _origGHEV = _orig.getHighEntropyValues.bind(_orig);
        _patched.getHighEntropyValues = async function(hints) {
          const result = await _origGHEV(hints);
          if (result && hints && hints.includes('platform')) result.platform = 'Windows';
          if (result && hints && hints.includes('platformVersion')) result.platformVersion = '10.0.0';
          return result;
        };
      }
      Object.defineProperty(navigator, 'userAgentData', {
        get: () => _patched, configurable: true, enumerable: true,
      });
    }
  } catch (_) {}

  // ── 6. Cookie banner + tab-conflict (ported verbatim from reference inject.ts) ─
  // The reference hides the cookie-consent banner with CSS (it's a notice, not a
  // functional gate) AND clicks the accept button, then auto-accepts the
  // "already open in another tab" modal by clicking "Да".
  try {
    const st = document.createElement('style');
    st.textContent = '.cookies-consent{display:none!important}';
    (document.head || document.documentElement).appendChild(st);
  } catch (_) {}

  const guard = () => {
    try {
      const btns = Array.from(document.querySelectorAll('button, .btn'));
      const cookieBtn =
        document.querySelector('.cookies-consent__button') ||
        btns.find(b => /принять/i.test((b.innerText || '').trim())) ||
        null;
      if (cookieBtn) cookieBtn.click();
      // "already open in another tab" modal → take over with "Да"
      if (/в другой вкладке/i.test(document.body?.innerText || '')) {
        const da = btns.find(b => (b.innerText || '').trim() === 'Да');
        if (da) da.click();
      }
    } catch (_) {}
  };
  try {
    const mo = new MutationObserver(guard);
    if (document.body) mo.observe(document.body, { childList: true, subtree: true });
    else document.addEventListener('DOMContentLoaded', () => {
      guard();
      try { mo.observe(document.body, { childList: true, subtree: true }); } catch (_) {}
    });
    setInterval(guard, 1500);
  } catch (_) {}
}
