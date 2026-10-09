// Match explicit native call actions, including the Kazakh audio site and its
// Russian/English translations. Anchors exclude unrelated navigation labels.
const flexibleWhitespace = pattern => new RegExp(pattern.source.replace('^', '^\\s*').replaceAll(' ', '\\s+'), pattern.flags);
export const startName = flexibleWhitespace(/^(?:Начать(?: нов(?:ый|ую|ое))?(?: разговор| беседу| общение| поиск| чат)?|Нов(?:ый (?:разговор|собеседник|чат)|ая беседа)|Искать(?: (?:нового )?собеседника)?|Поиск (?:нового )?собеседника|Следующий собеседник|Start(?: (?:a )?(?:new )?(?:call|conversation|search|chat))?|New (?:conversation|call|chat)|Find (?:a )?(?:new )?partner|Бастау|Іздеу|(?:Әңгіме|Әңгімені|Әңгімелесуді|Сөйлесуді|Сұхбатты|Іздеуді|Чатты)(?: қайта)? бастау|(?:Әңгімелесушіні|Сұхбаттасушыны) іздеу|Жаңа (?:әңгіме|сұхбат|чат))\s*[.!…]?\s*$/iu);
export const endName = flexibleWhitespace(/^(?:Завершить(?: разговор| беседу| общение)?|Закончить(?: разговор| беседу)|End (?:call|conversation|chat)|Disconnect|(?:Әңгімені|Әңгімелесуді|Сөйлесуді|Сұхбатты|Қоңырауды) аяқтау|Аяқтау)\s*[.!…]?\s*$/iu);
export const confirmEndName = flexibleWhitespace(/^(?:Да(?:,?\s+завершить)?|Завершить|Yes|End call|Confirm|Иә(?:,?\s+аяқтау)?|Аяқтау|Растау)\s*[.!…]?\s*$/iu);

export async function usableControls(locator) {
  const matches = [];
  for (let i = 0; i < await locator.count(); i++) {
    const candidate = locator.nth(i);
    if (await candidate.isVisible() && await candidate.isEnabled()) matches.push(candidate);
  }
  return matches;
}

export async function labelledCallControls(scope, name) {
  // Locator unions deduplicate anchors/buttons that also carry the native .btn
  // class. Do not click arbitrary text containers or invisible duplicates.
  const candidates = scope.getByRole('button', { name })
    .or(scope.getByRole('link', { name }))
    .or(scope.locator('.btn').filter({ hasText: name }));
  return usableControls(candidates);
}

// Read-only failure diagnostics: UI control labels, never the page body,
// partner identifiers, chat content, or the configured token.
export function readNativeControls({ token = '' } = {}) {
  const redact = text => (token ? text.split(token).join('[token]') : text)
    .replace(/\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/gi, '[token]')
    .replace(/[\w-]{40,}/g, '[redacted]').slice(0, 120);
  const result = [];
  for (const el of document.querySelectorAll('button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"], .btn')) {
    const style = getComputedStyle(el);
    if (!el.getClientRects().length || style.display === 'none' || style.opacity === '0' ||
        ['hidden', 'collapse'].includes(style.visibility)) continue;
    const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!name || name.length > 160) continue;
    result.push({ tag: el.tagName.toLowerCase(), id: redact(el.id || ''), name: redact(name),
      enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true' });
    if (result.length === 32) break;
  }
  return result;
}
