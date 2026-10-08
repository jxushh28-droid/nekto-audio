// These functions are serialized by Playwright and run inside the audio page.
// Prefer the supplied chat-store lookup; the audio client may use another module.
export function audioClientReady() {
  const apps = Array.from(document.querySelectorAll('*')).map(el => el.__vue__);
  return apps.some(app => app?.$store?.state?.user &&
    typeof (app.$socketActions || app.$store.$socketActions)?.authorize === 'function' &&
    typeof app.$store.commit === 'function' && typeof app.$store.subscribe === 'function' &&
    (app.$store.state.system?.socketConnected !== false ||
      app.$store.state.system?.captchaRequired || app.$store.state.system?.hcaptchaRequired));
}

export function authorizeAudioToken({ token, timeout = 15000, settle = 2000 }) {
  const apps = Array.from(document.querySelectorAll('*')).map(el => el.__vue__);
  const compatible = app => app?.$store?.state?.user &&
    typeof (app.$socketActions || app.$store.$socketActions)?.authorize === 'function' &&
    typeof app.$store.commit === 'function' && typeof app.$store.subscribe === 'function';
  const app = apps.find(app => compatible(app) && app.$store.state.chat) || apps.find(compatible);
  if (!app) return { ok: false, reason: 'client-not-ready' };
  const store = app.$store;
  const actions = app.$socketActions || store.$socketActions;
  const verification = () => !!(store.state.system?.captchaRequired || store.state.system?.hcaptchaRequired);
  if (verification()) return { ok: false, reason: 'verification-required' };
  if (store._mutations && !store._mutations['user/setAuthToken']) {
    return { ok: false, reason: 'client-incompatible' };
  }
  const confirmed = () => {
    const state = store.state;
    let persisted = false;
    try { persisted = JSON.parse(localStorage.getItem('storage_audio_v2'))?.user?.authToken === token; } catch {}
    return !verification() && state.system?.isAuth === true && state.system?.socketConnected === true &&
      state.user.authToken === token && state.user.tokenModel?.tokenInfo?.authToken === token && persisted;
  };
  const previouslyConfirmed = confirmed();
  return new Promise(resolve => {
    let finished = false, unsubscribe = () => {}, timer, settledTimer;
    const finish = result => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(settledTimer); unsubscribe(); resolve(result);
    };
    try {
      unsubscribe = store.subscribe(mutation => {
        if (verification()) return finish({ ok: false, reason: 'verification-required' });
        if (mutation.type !== 'user/socket_auth.successToken') return;
        // Let the client's persistence subscriber process the response first.
        Promise.resolve().then(() => {
          if (verification()) return finish({ ok: false, reason: 'verification-required' });
          const state = store.state;
          if (state.user.authToken !== token ||
              (state.user.tokenModel?.tokenInfo?.authToken != null &&
                state.user.tokenModel.tokenInfo.authToken !== token)) {
            return finish({ ok: false, reason: 'token-replaced' });
          }
          let persisted = false;
          try { persisted = JSON.parse(localStorage.getItem('storage_audio_v2'))?.user?.authToken === token; } catch {}
          if (!persisted) return finish({ ok: false, reason: 'storage-mismatch' });
          if (state.system?.isAuth === false || state.system?.socketConnected === false) {
            return finish({ ok: false, reason: 'authorization-failed' });
          }
          finish({ ok: true, reason: 'accepted' });
        });
      });
      timer = setTimeout(() => finish({ ok: false, reason: 'authorization-timeout' }), timeout);
      // Like the text client, allow a redundant authorize to retain an already
      // confirmed server-issued identity. A storage write alone cannot qualify.
      if (previouslyConfirmed) settledTimer = setTimeout(() => {
        if (confirmed()) finish({ ok: true, reason: 'existing-session-confirmed', responseReceived: false });
      }, settle);
      store.commit('user/setAuthToken', token);
      if (finished) return;
      if (store.state.user.authToken !== token) return finish({ ok: false, reason: 'client-incompatible' });
      const pending = actions.authorize();
      if (pending?.catch) pending.catch(() => finish({ ok: false, reason: 'authorization-failed' }));
    } catch { finish({ ok: false, reason: 'authorization-failed' }); }
  });
}

// Return only booleans; the full Vuex state contains credentials and user details.
export function audioTokenMatches(token) {
  const apps = Array.from(document.querySelectorAll('*')).map(el => el.__vue__);
  const compatible = app => app?.$store?.state?.user &&
    typeof (app.$socketActions || app.$store.$socketActions)?.authorize === 'function' &&
    typeof app.$store.commit === 'function' && typeof app.$store.subscribe === 'function';
  const app = apps.find(app => compatible(app) && app.$store.state.chat) || apps.find(compatible);
  const state = app?.$store.state;
  if (!state) return { ok: false, reason: 'client-not-ready' };
  if (state.system?.captchaRequired || state.system?.hcaptchaRequired) return { ok: false, reason: 'verification-required' };
  if (state.user.authToken !== token || (state.user.tokenModel?.tokenInfo?.authToken != null &&
      state.user.tokenModel.tokenInfo.authToken !== token)) return { ok: false, reason: 'token-replaced' };
  try {
    if (JSON.parse(localStorage.getItem('storage_audio_v2'))?.user?.authToken !== token) {
      return { ok: false, reason: 'storage-mismatch' };
    }
  } catch { return { ok: false, reason: 'storage-mismatch' }; }
  if (state.system?.isAuth === false || state.system?.socketConnected === false) return { ok: false, reason: 'authorization-failed' };
  return { ok: true, reason: 'accepted' };
}

const failures = {
  'client-not-ready': ['NEKTO_VUEX_NOT_READY', 'Nekto live Vuex client did not become ready.'],
  'client-incompatible': ['NEKTO_VUEX_INCOMPATIBLE', 'Nekto audio client does not support the expected token mutation.'],
  'verification-required': ['NEKTO_VERIFICATION', 'Nekto requires verification. Automatic search stopped.'],
  'token-replaced': ['NEKTO_TOKEN_REPLACED', 'Nekto replaced the supplied token during authorization. Set a valid audio-session token with /token.'],
  'storage-mismatch': ['NEKTO_TOKEN_STORAGE', 'Nekto live token and saved audio token do not match.'],
  'authorization-timeout': ['NEKTO_AUTH_TIMEOUT', 'Nekto did not confirm live token authorization. Check your audio-session token and try again.'],
};
export function authorizationError(reason) {
  const [code, message] = failures[reason] || ['NEKTO_AUTH_FAILED', 'Nekto live token authorization failed.'];
  return Object.assign(new Error(message), { code });
}
