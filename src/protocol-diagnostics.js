// Only fixed protocol types and credential equality reach the host.
export function describeProtocolMessage(plaintext, token, direction) {
  if (!['encrypt', 'decrypt'].includes(direction) ||
      typeof plaintext !== 'string' || plaintext.length > 65536) return null;
  let message;
  try { message = JSON.parse(plaintext); } catch { return null; }
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const types = ['register', 'registered', 'scan-for-peer', 'captcha-request',
    'peer-connect', 'peer-disconnect', 'search.success', 'error'];
  if (!types.includes(message.type)) return null;
  const report = { direction, type: message.type };
  if (message.type === 'register') {
    const field = typeof message.authToken === 'string' ? 'authToken' :
      typeof message.userId === 'string' ? 'userId' : 'none';
    report.credentialField = field;
    report.credentialMatches = field !== 'none' && !!token && message[field] === token;
  }
  if (message.type === 'scan-for-peer') {
    report.searchToken = !Object.hasOwn(message, 'token') ? 'missing' :
      message.token === null ? 'null' :
      message.token === '' ? 'empty' :
      typeof message.token === 'string' ? 'present' : 'other';
  }
  if (message.type === 'registered') {
    report.success = message.success === true ? 'true' : message.success === false ? 'false' : 'unspecified';
  }
  return report;
}

export function sanitizeProtocolReport(report) {
  if (!report || typeof report !== 'object' ||
      !['encrypt', 'decrypt'].includes(report.direction) ||
      !['register', 'registered', 'scan-for-peer', 'captcha-request', 'peer-connect',
        'peer-disconnect', 'search.success', 'error'].includes(report.type)) return null;
  const safe = { direction: report.direction, type: report.type };
  if (report.type === 'register') {
    safe.credentialField = ['authToken', 'userId', 'none'].includes(report.credentialField) ?
      report.credentialField : 'none';
    safe.credentialMatches = report.credentialMatches === true;
  }
  if (report.type === 'scan-for-peer') safe.searchToken =
    ['missing', 'null', 'empty', 'present', 'other'].includes(report.searchToken) ? report.searchToken : 'other';
  if (report.type === 'registered') safe.success =
    ['true', 'false', 'unspecified'].includes(report.success) ? report.success : 'unspecified';
  return safe;
}

export function updateProtocolSummary(previous, report) {
  const safe = sanitizeProtocolReport(report);
  if (!safe) return previous;
  const next = { ...previous };
  if (safe.direction === 'encrypt' && safe.type === 'register') {
    next.registrationPayloadObserved = true;
    next.credentialField = safe.credentialField;
    next.credentialMatches = safe.credentialMatches;
  }
  if (safe.direction === 'decrypt' && safe.type === 'registered') {
    next.registrationReplyObserved = true; next.registrationSuccess = safe.success;
  }
  if (safe.direction === 'encrypt' && safe.type === 'scan-for-peer') next.searchToken = safe.searchToken;
  if (safe.direction === 'decrypt' && safe.type === 'captcha-request') next.captchaRequested = true;
  return next;
}

// Serialized into the page. Passes every argument and the exact native Promise
// through unchanged. Stops after the first challenge/partner or after 90 seconds.
export function installProtocolObserver({ origin, token, describeMessage }) {
  if (location.origin !== origin || typeof describeMessage !== 'function') return false;
  if (window.__nektoProtocolObserver) return true;
  const subtle = window.crypto?.subtle;
  if (!subtle || typeof subtle.encrypt !== 'function' || typeof subtle.decrypt !== 'function') return false;
  const encrypt = subtle.encrypt, decrypt = subtle.decrypt;
  const encryptDescriptor = Object.getOwnPropertyDescriptor(subtle, 'encrypt');
  const decryptDescriptor = Object.getOwnPropertyDescriptor(subtle, 'decrypt');
  let active = true, count = 0, timer;
  const metadata = (data, direction) => {
    try {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) :
        ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
      if (!bytes || bytes.byteLength > 65536) return null;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return describeMessage(text, token, direction);
    } catch { return null; }
  };
  const restore = (name, wrapper, descriptor) => {
    if (subtle[name] !== wrapper) return;
    if (descriptor) Object.defineProperty(subtle, name, descriptor);
    else delete subtle[name];
  };
  const stop = () => {
    active = false; clearTimeout(timer);
    try { restore('encrypt', observedEncrypt, encryptDescriptor); } catch {}
    try { restore('decrypt', observedDecrypt, decryptDescriptor); } catch {}
    if (window.__nektoProtocolObserver?.stop === stop) delete window.__nektoProtocolObserver;
  };
  const emit = report => {
    if (!active || !report || count >= 40) return;
    count++;
    try { Promise.resolve(window.reportNektoProtocol?.(report)).catch(() => {}); } catch {}
    if (report.direction === 'decrypt' && ['captcha-request', 'peer-connect'].includes(report.type)) stop();
  };
  function observedEncrypt(...args) {
    const promise = Reflect.apply(encrypt, this, args);
    const report = active ? metadata(args[2], 'encrypt') : null;
    if (report) {
      try { promise.then(() => emit(report), () => {}); } catch {}
    }
    return promise;
  }
  function observedDecrypt(...args) {
    const promise = Reflect.apply(decrypt, this, args);
    if (active) {
      try { promise.then(data => emit(metadata(data, 'decrypt')), () => {}); } catch {}
    }
    return promise;
  }
  try {
    subtle.encrypt = observedEncrypt; subtle.decrypt = observedDecrypt;
    if (subtle.encrypt !== observedEncrypt || subtle.decrypt !== observedDecrypt) { stop(); return false; }
    window.__nektoProtocolObserver = { stop };
    timer = setTimeout(stop, 90000);
    window.addEventListener('pagehide', stop, { once: true });
    return true;
  } catch { stop(); return false; }
}

export function protocolObserverScript({ origin, token }) {
  return '(' + installProtocolObserver.toString() + ')({origin:' +
    JSON.stringify(origin) + ',token:' + JSON.stringify(token) +
    ',describeMessage:' + describeProtocolMessage.toString() + '});';
}
