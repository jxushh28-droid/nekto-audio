import { readAudioCallState } from './call-state.js';
import { authorizationError } from './live-session.js';

// Read provider documents only to observe loading. Never interact with their
// controls or inspect/submit a verification response.
function providerFrame(url) {
  try {
    const { hostname, pathname } = new URL(url);
    return ((hostname === 'google.com' || hostname.endsWith('.google.com') ||
      hostname === 'recaptcha.net' || hostname.endsWith('.recaptcha.net')) && pathname.startsWith('/recaptcha/')) ||
      hostname === 'hcaptcha.com' || hostname.endsWith('.hcaptcha.com');
  } catch { return false; }
}

export function verificationFrameLoaded() {
  return document.readyState === 'complete' && !!document.body?.children.length &&
    [...document.images].every(image => image.complete && image.naturalWidth > 0);
}

export async function waitForVerificationWidget(page, { check = () => {}, timeout = 25000,
  interval = 100, settleTime = 500 } = {}) {
  const deadline = Date.now() + timeout;
  let readySince = null;
  do {
    check();
    const state = await page.evaluate(readAudioCallState);
    check();
    if (state.restricted) throw authorizationError('native-restriction');
    if (!state.verification) return 'cleared';
    let shown = 0, loaded = true;
    for (const frame of page.frames()) {
      if (!providerFrame(frame.url())) continue;
      try {
        const element = await frame.frameElement();
        try {
          if (!await element.isVisible()) continue;
          shown++;
          if (!await frame.evaluate(verificationFrameLoaded)) loaded = false;
        } finally { await element.dispose(); }
      } catch { loaded = false; } // A replacing/loading frame is not ready.
      check();
    }
    if (shown && loaded) {
      readySince ??= Date.now();
      if (Date.now() - readySince >= settleTime) return 'loaded';
    } else readySince = null;
    await new Promise(resolve => setTimeout(resolve, interval));
  } while (Date.now() < deadline);
  check();
  // A missing or failed widget stays visible for the user, without navigation.
  throw authorizationError('verification-required');
}
