// Serialized by Playwright. Audio uses native registration and user.tokenId;
// its startup is different from the text client's authorize/successToken flow.
export function audioClientReady() {
  return Array.from(document.querySelectorAll('*')).some(el => {
    const state = el.__vue__?.$store?.state;
    return !!(state?.user && state.system && (state.system.isFirstLoaded ||
      state.system.captchaRequired || state.system.hcaptchaRequired ||
      state.system.forceDisconnectReason || state.system.errorRegistered ||
      state.system.isAuth && state.system.socketConnected && state.user.tokenId != null));
  });
}

export function confirmAudioToken({ token, timeout = 15000, pollInterval = 100 }) {
  const store = Array.from(document.querySelectorAll('*')).map(el => el.__vue__?.$store)
    .find(store => store?.state?.user && store.state.system);
  if (!store) return { ok: false, reason: 'client-not-ready' };
  // Never return the full state: it contains tokens and personal details.
  const snapshot = () => {
    let saved = false;
    try { saved = JSON.parse(localStorage.getItem('storage_audio_v2'))?.user?.authToken === token; } catch {}
    const { user = {}, system = {} } = store.state;
    const error = Number(system.errorRegistered);
    return {
      savedTokenMatches: saved, liveTokenMatches: user.authToken === token,
      identityPresent: user.tokenId != null, authenticated: system.isAuth === true,
      socketConnected: system.socketConnected === true,
      captcha: !!system.captchaRequired, hcaptcha: !!system.hcaptchaRequired,
      restricted: !!system.forceDisconnectReason,
      registrationError: Number.isSafeInteger(error) ? error : 0,
    };
  };
  const outcome = () => {
    const diagnostics = snapshot();
    const d = diagnostics;
    let reason, ok = false;
    if (d.captcha || d.hcaptcha) reason = 'verification-required';
    else if (d.restricted) reason = 'native-restriction';
    else if (d.registrationError) reason = 'native-registration-error';
    else if (d.savedTokenMatches && d.liveTokenMatches && d.identityPresent && d.authenticated && d.socketConnected) {
      ok = true; reason = 'native-session-confirmed';
    } else if (d.authenticated && d.identityPresent && (!d.liveTokenMatches || !d.savedTokenMatches)) {
      reason = 'token-not-accepted';
    }
    return reason ? { ok, reason, diagnostics } : null;
  };
  const initial = outcome();
  if (initial) return initial;
  return new Promise(resolve => {
    let done = false, unsubscribe = () => {}, timer, poll;
    const finish = result => {
      if (done) return;
      done = true; clearTimeout(timer); clearInterval(poll); unsubscribe(); resolve(result);
    };
    const check = () => {
      if (done) return;
      const result = outcome();
      if (result) finish(result);
    };
    try {
      if (typeof store.subscribe === 'function') unsubscribe = store.subscribe(() => Promise.resolve().then(check));
      timer = setTimeout(() => finish({ ok: false, reason: 'authorization-timeout', diagnostics: snapshot() }), timeout);
      // Observe state as well as mutations: no text-only event is required.
      poll = setInterval(check, pollInterval);
      check();
    } catch { finish({ ok: false, reason: 'authorization-failed', diagnostics: snapshot() }); }
  });
}

const failures = {
  'client-not-ready': ['NEKTO_VUEX_NOT_READY', 'Nekto audio Vuex client did not become ready.'],
  'verification-required': ['NEKTO_VERIFICATION', 'Nekto requires verification. Automatic search stopped.'],
  'native-restriction': ['NEKTO_RESTRICTED', 'Nekto restricted this audio session. Automatic search stopped.'],
  'native-registration-error': ['NEKTO_REGISTRATION', 'Nekto reported an audio registration error. See /status for its numeric code.'],
  'token-not-accepted': ['NEKTO_TOKEN_REPLACED', 'Nekto did not retain the supplied audio token. Set a valid audio-session token with /token.'],
  'authorization-timeout': ['NEKTO_AUTH_TIMEOUT', 'Nekto audio registration did not complete. See /status for connection and token checks.'],
};
export function authorizationError(reason) {
  const [code, message] = failures[reason] || ['NEKTO_AUTH_FAILED', 'Nekto audio token authorization failed.'];
  return Object.assign(new Error(message), { code });
}
