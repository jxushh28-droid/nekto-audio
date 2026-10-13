// Injected before the site's scripts. Normalizes the handful of JS signals that
// differ between Chrome's headless and headful modes, so a headless run looks the
// same as the headful browser that nekto accepts. Every patch makes headless match
// what REAL headful Chrome reports — no fake/inconsistent values, so there is
// nothing new for nekto to flag. Safe to run in headful too (it becomes a no-op).
export function installHeadlessNormalize() {
  // 1. Notification permission. Headless reports 'denied'; real Chrome reports
  //    'default'/'prompt' until the user decides. This is the classic headless tell.
  try {
    const orig = navigator.permissions && navigator.permissions.query
      ? navigator.permissions.query.bind(navigator.permissions) : null;
    if (orig) {
      navigator.permissions.query = function(desc) {
        if (desc && desc.name === 'notifications') {
          return Promise.resolve({
            state: 'prompt', name: 'notifications', onchange: null,
            addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
          });
        }
        return orig(desc);
      };
    }
  } catch (_) {}

  // 2. navigator.webdriver — automation flag. Real users never have it true.
  try {
    if (navigator.webdriver) {
      Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
    }
  } catch (_) {}

  // 3. window.chrome — present in real Chrome, sometimes missing/thin in headless.
  try {
    if (!window.chrome) {
      Object.defineProperty(window, 'chrome', {
        get: () => ({ runtime: {}, app: {}, loadTimes: () => {}, csi: () => {} }),
        configurable: true,
      });
    } else if (!window.chrome.runtime) {
      try { window.chrome.runtime = {}; } catch (_) {}
    }
  } catch (_) {}

  // 4. Window outer dimensions. Headless can report outerWidth/outerHeight = 0,
  //    which no real window has. Mirror the inner size (+ typical chrome height).
  try {
    if (!window.outerWidth || !window.outerHeight) {
      Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth, configurable: true });
      Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85, configurable: true });
    }
  } catch (_) {}
}
