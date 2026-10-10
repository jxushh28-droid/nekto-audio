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

  // ── 1. FPT hash bypass ──────────────────────────────────────────────────────
  // nekto encrypts WS frames with WebCrypto. The "set-fpt" event carries a
  // FingerprintJS visitorId (fpt field) that nekto uses as device identity for
  // shadow/phantom bans. We swap it with md5(token) so every token has its own
  // stable device id and bans never cross-contaminate between slots.
  if (fptHash && typeof crypto !== 'undefined' && crypto.subtle) {
    const _enc = crypto.subtle.encrypt.bind(crypto.subtle);
    const patched = async function(algo, key, data) {
      try {
        let buf;
        if (data instanceof ArrayBuffer) buf = data;
        else if (ArrayBuffer.isView(data)) buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        if (buf) {
          const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
          if (text.includes('"fpt"') || text.includes('"deviceInfo"') || text.includes('"canvas"') ||
              text.includes('"gumHash"') || text.includes('"type"') && text.includes('"register"')) {
            try {
              const obj = JSON.parse(text);
              if (obj && typeof obj === 'object') {
                // 1. Replace FPT hash with per-token stable id (prevents cross-slot ban contamination).
                //    CRITICAL: Do NOT replace fpt when type === 'set-fpt'.
                //    The set-fpt message includes `infoDataS` which is AES-CBC encrypted using
                //    key = (original_fpt + authToken + tokenId). If we replace fpt here the server
                //    reconstructs a different key, decryption fails, and the account gets shadow-banned.
                //    fpt replacement is only needed in the 'register' message (WS envelope payload).
                if (fptHash && typeof obj.fpt === 'string' && obj.fpt !== fptHash && obj.type !== 'set-fpt') {
                  obj.fpt = fptHash;
                }

                // 2. Replace gumHash — nekto computes this from the getUserMedia audio stream.
                //    With --use-fake-device-for-media-stream the hash is a bot fingerprint.
                //    Replace with SHA-256(token)-derived value: stable per token, looks real.
                if (gumHash && typeof obj.gumHash === 'string') obj.gumHash = gumHash;

                // 3. Remove canvas / plugins / duration — top-level bot-detection fields.
                //    These components expose automation even with spoofed values and are
                //    flagged by the server's shadow-ban logic (per bundle analysis).
                delete obj.canvas;
                delete obj.plugins;
                delete obj.duration;

                // 4. Strip `ua` from deviceInfo (UAParser result).
                //    nekto's own code does `delete t.ua` before sending device info;
                //    if we don't match this, the field mismatch triggers VPGEN failure.
                if (obj.deviceInfo && typeof obj.deviceInfo === 'object') {
                  delete obj.deviceInfo.ua;
                  delete obj.deviceInfo['user-agent'];
                }

                // 5. Same cleanup on nested webglInfo.components if present
                if (obj.webglInfo && obj.webglInfo.components) {
                  delete obj.webglInfo.components.canvas;
                }

                data = new TextEncoder().encode(JSON.stringify(obj));
              }
            } catch (_) {}
          }
        }
      } catch (_) {}
      return _enc(algo, key, data);
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

  // ── 6. Tab-conflict auto-click ───────────────────────────────────────────────
  // NOTE: Do NOT hide the cookie banner with CSS. Nekto's server sees the WS
  // connection and checks whether cookies were accepted (via a flag in its Vue
  // store / localStorage). Hiding the button with CSS bypasses the click without
  // firing the acceptance event → server sends captcha-request.
  // The proper fix is to click #acceptCookies via Playwright BEFORE this init
  // script matters; see nekto.js openSession().

  // nekto shows a "Да / Нет" modal when another tab already holds the authToken.
  // Auto-click "Да" to let this tab take over (matches old TS inject.ts behavior).
  try {
    const TAB_CONFLICT_SELECTORS = [
      // nekto-specific conflict dialog buttons
      'button[data-action="continue"]',
      '.modal button:first-of-type',
    ];
    const CONFIRM_TEXTS = ['да', 'yes', 'ок', 'ok', 'continue', 'продолжить'];

    const tryClickConflict = () => {
      try {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if (!CONFIRM_TEXTS.includes(text)) continue;
          // Only click if it looks like a conflict/modal context
          const inModal = btn.closest('[class*="modal"],[class*="dialog"],[class*="popup"],[class*="conflict"],[class*="alert"]');
          if (inModal) { btn.click(); return; }
        }
      } catch (_) {}
    };

    const _obs = new MutationObserver(tryClickConflict);
    _obs.observe(document.documentElement, { childList: true, subtree: true });
    // Disconnect after 30s to avoid leaking the observer on long-lived pages.
    setTimeout(() => { try { _obs.disconnect(); } catch (_) {} }, 30000);
  } catch (_) {}
}
