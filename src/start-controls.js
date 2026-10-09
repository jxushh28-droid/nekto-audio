import { readAudioCallState, assertCallAvailable } from './call-state.js';
import { searchError } from './search-error.js';

const startName = /^(?:Начать(?: новый)?(?: разговор| беседу| общение| поиск)?|Новый (?:разговор|собеседник)|Start(?: (?:a )?(?:new )?(?:call|conversation|search))?|New conversation)\s*$/i;

async function usable(locator) {
  const matches = [];
  for (let i = 0; i < await locator.count(); i++) {
    const candidate = locator.nth(i);
    if (await candidate.isVisible() && await candidate.isEnabled()) matches.push(candidate);
  }
  return matches;
}

export async function waitForStartControl(page, { check = () => {}, timeout = 30000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  do {
    check();
    const state = await page.evaluate(readAudioCallState);
    check(); assertCallAvailable(state);
    if (state.searching || state.partnerConnected) return { state, button: null };
    let matches = await usable(page.locator('#searchCompanyBtn'));
    if (!matches.length) matches = await usable(page.getByRole('button', { name: startName }));
    check();
    if (matches.length > 1) throw searchError('control-ambiguous');
    if (matches.length === 1) return { state, button: matches[0] };
    await new Promise(resolve => setTimeout(resolve, interval));
  } while (Date.now() < deadline);
  throw searchError('control');
}

export async function inspectStartControls(page) {
  const result = {};
  for (const [prefix, locator] of [['start', page.locator('#searchCompanyBtn')],
    ['cookies', page.locator('#acceptCookies')]]) {
    const count = await locator.count(); let visible = 0, enabled = 0;
    for (let i = 0; i < count; i++) {
      const candidate = locator.nth(i);
      if (await candidate.isVisible()) { visible++; if (await candidate.isEnabled()) enabled++; }
    }
    result[`${prefix}Matches`] = count; result[`${prefix}Visible`] = visible; result[`${prefix}Enabled`] = enabled;
  }
  return result;
}
