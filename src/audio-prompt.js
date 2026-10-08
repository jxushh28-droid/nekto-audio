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

export async function respondToAudioPrompt(page, { value, automatic = false } = {}) {
  const prompt = await page.evaluate(readAudioPrompt);
  if (!prompt.visible) throw new Error('Nekto has no visible website prompt.');
  if (['verification', 'restriction', 'microphone-error'].includes(prompt.category)) {
    return { handled: false, prompt };
  }
  // Automatic clicks are limited to routine call/microphone confirmations.
  if (automatic && (!['microphone-confirm', 'call-confirm'].includes(prompt.category) || prompt.fieldCount)) {
    return { handled: false, prompt };
  }
  if (!automatic && !['age', 'gender', 'microphone-confirm', 'call-confirm'].includes(prompt.category)) {
    return { handled: false, prompt };
  }
  if (!prompt.confirmEnabled) return { handled: false, prompt };
  if (prompt.fieldCount) {
    if (prompt.fieldCount !== 1 || value == null || !value.trim()) return { handled: false, prompt };
    const field = page.locator('.swal2-popup').filter({ visible: true })
      .locator('input:not([type="hidden"]), select, textarea').filter({ visible: true });
    if (prompt.inputType === 'select') await field.selectOption({ label: value.trim() });
    else if (['text', 'number', 'textarea'].includes(prompt.inputType)) await field.fill(value.trim());
    else return { handled: false, prompt };
  }
  await page.locator('.swal2-popup').filter({ visible: true }).locator('.swal2-confirm').click({ timeout: 3000 });
  return { handled: true, prompt };
}

export function promptMessage(prompt, token = '') {
  const text = token ? prompt.text?.split(token).join('[token]') : prompt.text;
  const options = prompt.options?.length ? ` Options: ${prompt.options.join(', ')}.` : '';
  return `Nekto prompt (${prompt.category || 'unknown'}): ${text || 'No readable prompt text.'}${options}`;
}
