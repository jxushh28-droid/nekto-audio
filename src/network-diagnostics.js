// Read-only diagnostics. Never return raw URLs, socket bodies or credential values.
export function classifyNektoRequest(raw) {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return null;
    const host = url.hostname;
    if (host === 'nekto-me.kz') return 'site';
    if (host === 'audio.nekto-me.kz') return 'audio';
    if ((host === 'google.com' || host.endsWith('.google.com') ||
         host === 'gstatic.com' || host.endsWith('.gstatic.com') ||
         host === 'recaptcha.net' || host.endsWith('.recaptcha.net')) &&
        url.pathname.startsWith('/recaptcha/')) return 'captcha';
    if (host === 'hcaptcha.com' || host.endsWith('.hcaptcha.com')) return 'captcha';
    return null;
  } catch { return null; }
}

export function describeNativeFlag(value) {
  if (value === null) return { type: 'null' };
  const type = typeof value;
  if (type === 'boolean') return { type, value };
  if (type === 'number') return { type, value: [-1, 0, 1].includes(value) ? value : '[other number]' };
  if (type === 'string') {
    const normalized = value.trim().toLowerCase();
    return { type, value: ['', 'false', 'true', '0', '1'].includes(normalized) ? normalized : '[other string]' };
  }
  return { type: type === 'object' && Array.isArray(value) ? 'array' : type };
}

function eventCategory(value) {
  if (typeof value !== 'string' || value.length > 80) return 'other';
  if (/captcha|verification/i.test(value)) return 'verification';
  if (/authorize|authorization|register|registration|auth/i.test(value)) return 'authorization';
  if (/search|company|partner/i.test(value)) return 'search';
  if (/error|disconnect/i.test(value)) return 'error';
  return 'other';
}

export function describeSocketFrame(payload, token) {
  if (typeof payload !== 'string' || payload.length > 131072) return null;
  let parsed;
  try { parsed = JSON.parse(payload.replace(/^42(?:\/[^,]{1,64},)?\d*(?=\[)/, '')); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const result = { category: 'other', tokenFieldPresent: false, configuredTokenPresent: false };
  let visited = 0;
  const walk = (value, depth) => {
    if (++visited > 1024 || depth > 8) return;
    if (typeof value === 'string') {
      if (token && value === token) result.configuredTokenPresent = true;
      if (/^[\[{]/.test(value) && value.length <= 131072) {
        try { walk(JSON.parse(value), depth + 1); } catch {}
      }
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      if (depth === 0) result.category = eventCategory(value[0]);
      for (const item of value.slice(0, 64)) walk(item, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(value).slice(0, 64)) {
      if (/^(authToken|token)$/i.test(key)) result.tokenFieldPresent = true;
      if (/^(event|type|action|method|cmd|command)$/i.test(key)) {
        const category = eventCategory(child);
        if (result.category === 'other' && category !== 'other') result.category = category;
      }
      if (/^(captchaRequired|hcaptchaRequired)$/i.test(key)) result[key.toLowerCase()] = describeNativeFlag(child);
      walk(child, depth + 1);
    }
  };
  walk(parsed, 0);
  return result;
}

export function safeMutationType(value) {
  return typeof value === 'string' && value.length <= 80 &&
    /^(system|user)\/[a-zA-Z_.]+$/.test(value) ? value : 'other';
}

export function sanitizeVerificationReport(report) {
  if (!report || typeof report !== 'object') return null;
  const sanitizeFlag = flag => {
    if (!flag || typeof flag !== 'object') return { type: 'unknown' };
    if (['undefined', 'null', 'object', 'array'].includes(flag.type)) return { type: flag.type };
    if (flag.type === 'boolean' && typeof flag.value === 'boolean') return describeNativeFlag(flag.value);
    if (flag.type === 'number' && ([-1, 0, 1].includes(flag.value) || flag.value === '[other number]')) {
      return { type: 'number', value: flag.value };
    }
    if (flag.type === 'string' && ['', 'false', 'true', '0', '1', '[other string]'].includes(flag.value)) {
      return { type: 'string', value: flag.value };
    }
    return { type: 'unknown' };
  };
  return {
    mutation: safeMutationType(report.mutation),
    captcha: sanitizeFlag(report.captcha),
    hcaptcha: sanitizeFlag(report.hcaptcha),
    recaptchaApi: report.recaptchaApi === true,
    hcaptchaApi: report.hcaptchaApi === true,
    challengeFrames: Number.isInteger(report.challengeFrames) ?
      Math.max(0, Math.min(20, report.challengeFrames)) : 0,
  };
}

// Serialized into Chromium: observes Vuex but does not commit or dispatch.
export function installVerificationObserver({ origin } = {}) {
  if (origin && location.origin !== origin) return null;
  if (window.__nektoVerificationObserver) return window.__nektoVerificationObserver.snapshot();
  const describe = value => {
    if (value === null) return { type: 'null' };
    const type = typeof value;
    if (type === 'boolean') return { type, value };
    if (type === 'number') return { type, value: [-1, 0, 1].includes(value) ? value : '[other number]' };
    if (type === 'string') {
      const normalized = value.trim().toLowerCase();
      return { type, value: ['', 'false', 'true', '0', '1'].includes(normalized) ? normalized : '[other string]' };
    }
    return { type: type === 'object' && Array.isArray(value) ? 'array' : type };
  };
  let timer, unsubscribe;
  const deadline = Date.now() + 45000;
  const attach = () => {
    if (window.__nektoVerificationObserver) return;
    const vm = Array.from(document.querySelectorAll('*')).map(el => el.__vue__)
      .find(vm => vm?.$store?.state?.system && vm.$store.state.user);
    const store = vm?.$store;
    if (!store || typeof store.subscribe !== 'function') {
      if (Date.now() < deadline) timer = setTimeout(attach, 50);
      return;
    }
    const snapshot = () => ({
      captcha: describe(store.state.system?.captchaRequired),
      hcaptcha: describe(store.state.system?.hcaptchaRequired),
      recaptchaApi: !!window.grecaptcha,
      hcaptchaApi: !!window.hcaptcha,
      challengeFrames: Array.from(document.querySelectorAll('iframe')).filter(frame =>
        /(?:recaptcha|hcaptcha)/i.test(frame.src)).length,
    });
    let previous = JSON.stringify([snapshot().captcha, snapshot().hcaptcha]);
    const send = (mutation, state) => {
      const safeType = typeof mutation === 'string' && mutation.length <= 80 &&
        /^(system|user)\/[a-zA-Z_.]+$/.test(mutation) ? mutation : 'other';
      try { Promise.resolve(window.reportNektoVerification?.({ mutation: safeType, ...state })).catch(() => {}); } catch {}
    };
    unsubscribe = store.subscribe(mutation => {
      try {
        const state = snapshot();
        const signature = JSON.stringify([state.captcha, state.hcaptcha]);
        if (signature !== previous) { previous = signature; send(mutation?.type, state); }
      } catch { /* Observability must not interrupt native Vuex mutations. */ }
    });
    window.__nektoVerificationObserver = { snapshot };
    send('baseline', snapshot());
  };
  window.addEventListener('pagehide', () => { clearTimeout(timer); unsubscribe?.(); }, { once: true });
  attach();
  return window.__nektoVerificationObserver?.snapshot() || null;
}

export async function attachNektoDiagnostics(page, token, { current = () => true, log = report => console.log(JSON.stringify(report)), origin = 'https://nekto-me.kz' } = {}) {
  const emit = report => { if (current()) log(report); };
  page.on('requestfailed', request => {
    const target = classifyNektoRequest(request.url());
    if (!target) return;
    const code = request.failure()?.errorText;
    emit({ event: 'nekto_request_failed', target,
      code: typeof code === 'string' && /^net::ERR_[A-Z_]+$/.test(code) ? code : 'request-failed' });
  });
  page.on('response', response => {
    const target = classifyNektoRequest(response.url());
    if (target && response.status() >= 400) emit({ event: 'nekto_http_failed', target, status: response.status() });
  });
  page.on('websocket', socket => {
    const target = classifyNektoRequest(socket.url());
    if (!['site', 'audio'].includes(target)) return;
    emit({ event: 'nekto_socket_open', target });
    for (const [event, direction] of [['framesent', 'sent'], ['framereceived', 'received']]) {
      socket.on(event, frame => {
        const report = describeSocketFrame(frame.payload, token);
        if (report && (report.category !== 'other' || report.tokenFieldPresent ||
            report.configuredTokenPresent || report.captcharequired || report.hcaptcharequired)) {
          emit({ event: 'nekto_socket_trace', target, direction, ...report });
        }
      });
    }
    socket.on('socketerror', () => emit({ event: 'nekto_socket_error', target }));
    socket.on('close', () => emit({ event: 'nekto_socket_closed', target }));
  });
  await page.exposeBinding('reportNektoVerification', ({ frame }, report) => {
    if (!current() || frame !== page.mainFrame()) return;
    try { if (new URL(frame.url()).origin !== origin) return; } catch { return; }
    const safe = sanitizeVerificationReport(report);
    if (safe) emit({ event: 'nekto_verification_transition', ...safe });
  });
  await page.addInitScript(installVerificationObserver, { origin });
}
