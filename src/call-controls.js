import { readAudioCallState, waitForAudioSearch } from './call-state.js';
import { authorizationError } from './live-session.js';
import { searchError } from './search-error.js';

// Use only visible, enabled controls with an explicit call-related label.
// An unknown layout fails in place instead of opening another registration.
async function control(page, name, scope = page, optional = false) {
  const candidates = scope.getByRole('button', { name });
  const matches = [];
  for (let i = 0; i < await candidates.count(); i++) {
    const candidate = candidates.nth(i);
    if (await candidate.isVisible() && await candidate.isEnabled()) matches.push(candidate);
  }
  if (!matches.length && optional) return null;
  if (matches.length !== 1) throw searchError('next-control');
  return matches[0];
}

export function assertCallAvailable(state) {
  if (state.verification) throw authorizationError('verification-required');
  if (state.restricted) throw authorizationError('native-restriction');
  if (state.attention) throw searchError('attention');
}

export async function advanceAudioCall(page, { check = () => {}, authorize, timeout = 15000, interval = 250 } = {}) {
  check();
  let state = await page.evaluate(readAudioCallState);
  check(); assertCallAvailable(state);
  await authorize(); check();
  if (state.searching && !state.partnerConnected) return state; // Do not restart an active search.
  if (state.partnerConnected) {
    const end = await control(page, /^(?:Завершить(?: разговор| беседу)?|Закончить разговор|End (?:call|conversation)|Disconnect)\s*$/i);
    check(); await end.click({ timeout: 5000 }); check();
    const deadline = Date.now() + timeout;
    let confirmed = false;
    do {
      state = await page.evaluate(readAudioCallState);
      check();
      if (state.attention && !state.restricted && !state.verification && !confirmed) {
        const popup = page.locator('.swal2-popup');
        const text = await popup.innerText({ timeout: 3000 });
        // Only the ordinary end-call confirmation opened by our own End click.
        if (/^(?=[\s\S]*(?:завершить|закончить)\s+(?:разговор|беседу))(?=[\s\S]*(?:уверены|действительно))/i.test(text.trim()) ||
            /(?:are you sure|confirm)[\s\S]*(?:end|disconnect)[\s\S]*(?:call|conversation)/i.test(text)) {
          const yes = await control(page, /^(?:Да(?:,?\s+завершить)?|Завершить|Yes|End call|Confirm)\s*$/i, popup);
          check(); await yes.click({ timeout: 5000 }); check(); confirmed = true;
          continue;
        }
      }
      assertCallAvailable(state);
      if (!state.partnerConnected) break;
      await new Promise(resolve => setTimeout(resolve, interval));
    } while (Date.now() < deadline);
    if (state.partnerConnected) throw searchError('next-confirm');
  }
  check(); assertCallAvailable(state);
  if (state.searching) return state; // Native End may already have started the next search.
  let start;
  const deadline = Date.now() + timeout;
  do {
    state = await page.evaluate(readAudioCallState);
    check(); assertCallAvailable(state);
    if (state.searching || state.partnerConnected) return state;
    const primary = page.locator('#searchCompanyBtn');
    start = await primary.isVisible() ? primary : await control(page,
      /^(?:Начать(?: новый)? (?:разговор|беседу)|Новый (?:разговор|собеседник)|Start (?:a )?(?:new )?(?:call|conversation)|New conversation)\s*$/i, page, true);
    check();
    if (start) break;
    await new Promise(resolve => setTimeout(resolve, interval));
  } while (Date.now() < deadline);
  if (!start) throw searchError('next-control');
  await authorize(); check();
  await start.click({ timeout: 5000 });
  return waitForAudioSearch(page, { check, timeout, interval });
}
