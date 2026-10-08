// Serialized into the native audio page. Inspect only the visible modal.
export function readAudioPrompt() {
  const visible = el => !!el?.isConnected && (el.checkVisibility
    ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    : el.getClientRects().length && getComputedStyle(el).display !== 'none');
  const popup = [...document.querySelectorAll('.swal2-popup')].find(visible);
  if (!popup) return { visible: false };
  const store = [...document.querySelectorAll('*')].map(el => el.__vue__?.$store)
    .find(store => store?.state?.system && store.state.user);
  const system = store?.state.system;
  const title = popup.querySelector('.swal2-title')?.textContent?.trim() || '';
  const body = popup.querySelector('.swal2-html-container, .swal2-content')?.textContent?.trim() || '';
  const text = (title + '\n' + body).trim().slice(0, 500) || (popup.textContent || '').trim().slice(0, 500);
  const fields = [...popup.querySelectorAll('input:not([type="hidden"]), select, textarea')].filter(visible);
  const confirm = popup.querySelector('.swal2-confirm');
  const verification = !!(system?.captchaRequired || system?.hcaptchaRequired) ||
    !!popup.querySelector('iframe[src*="captcha"], .g-recaptcha, .h-captcha') ||
    /captcha|капч|verify.*human|human verification|(?:провер|подтверд).*(человек|робот)|не робот|unusual traffic/i.test(text);
  const restricted = !!system?.forceDisconnectReason || popup.classList.contains('banPopup') ||
    /заблокирован|забанен|banned|blocked|ограничен доступ/i.test(text);
  const category = verification ? 'verification' : restricted ? 'restriction' :
    /доступ.*микрофон.*(?:запрещ|отказ)|microphone.*(?:denied|not allowed)|microphone permission.*denied/i.test(text) ? 'microphone-denied' :
    /микрофон.*(не найден|не обнаруж|недоступ|отсутств)|microphone.*(not found|unavailable|missing)|no microphone/i.test(text) ? 'microphone-error' :
    /возраст|\bage\b/i.test(text) ? 'age' : /ваш пол|выберите пол|\bgender\b/i.test(text) ? 'gender' :
    /разреш(ите|ить).*микрофон|доступ.*микрофон|allow.*microphone|enable.*microphone/i.test(text) ? 'microphone-confirm' :
    /начать (разговор|поиск)|start (conversation|search)|начать общение/i.test(text) ? 'call-confirm' : 'unknown';
  return { visible: true, category, text, fieldCount: fields.length,
    inputType: fields.length === 1 ? (fields[0].tagName === 'SELECT' ? 'select' : fields[0].type || 'text') : null,
    options: fields.length === 1 && fields[0].tagName === 'SELECT'
      ? [...fields[0].options].filter(option => !option.disabled).map(option => option.textContent.trim().slice(0, 60)).slice(0, 12) : [],
    confirmLabel: visible(confirm) ? (confirm.textContent || '').trim().slice(0, 80) : null,
    confirmEnabled: visible(confirm) && !confirm.disabled };
}

