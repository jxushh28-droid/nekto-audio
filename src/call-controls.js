import { readAudioCallState, waitForAudioSearch, assertCallAvailable } from './call-state.js';
import { searchError } from './search-error.js';
import { waitForStartControl } from './start-controls.js';
import { endName, confirmEndName, acknowledgeCallName, startName, labelledCallControls } from './native-controls.js';
import { readAudioPrompt } from './audio-prompt.js';
import { authorizationError } from './live-session.js';

// Use only visible, enabled controls with an explicit call-related label.
// An unknown layout fails in place instead of opening another registration.
async function control(scope, name) {
  const matches = await labelledCallControls(scope, name);
  if (matches.length !== 1) throw searchError('next-control');
  return matches[0];
}

// Handle only ordinary call confirmations/notices, including one already open
// when /next arrives. Verification, restrictions and forms remain untouched.
async function settleCallPrompt(page, { check, timeout, interval, endCurrentCall }) {
  let state = await page.evaluate(readAudioCallState);
  check();
  if (!state.attention) { assertCallAvailable(state); return state; }
  assertCallAvailable({ ...state, attention: false });
  const prompt = await page.evaluate(readAudioPrompt);
  check();
  if (prompt.category === 'verification') throw authorizationError('verification-required');
  if (prompt.category === 'restriction') throw authorizationError('native-restriction');
  if (prompt.fieldCount || !['end-confirm', 'call-ended'].includes(prompt.category) ||
      (prompt.category === 'end-confirm' && !endCurrentCall)) throw searchError('attention');
  const popups = page.locator('.swal2-popup');
  const visible = [];
  for (let i = 0; i < await popups.count(); i++) {
    const popup = popups.nth(i);
    if (await popup.isVisible()) visible.push(popup);
  }
  check();
  if (visible.length !== 1) {
    state = await page.evaluate(readAudioCallState); check(); assertCallAvailable(state);
    return state;
  }
  const label = prompt.category === 'end-confirm' ? confirmEndName :
    new RegExp(`${acknowledgeCallName.source}|${startName.source}`, 'iu');
  const confirm = await control(visible[0], label);
  check(); await confirm.click({ timeout: 5000 }); check();
  const deadline = Date.now() + timeout;
  do {
    state = await page.evaluate(readAudioCallState);
    check(); assertCallAvailable({ ...state, attention: false });
    if (!state.attention) return state;
    await new Promise(resolve => setTimeout(resolve, interval));
  } while (Date.now() < deadline);
  throw searchError('next-confirm');
}

export async function advanceAudioCall(page, { check = () => {}, authorize, endCurrentCall = true,
  startSearch = true, timeout = 15000, startTimeout = 30000, interval = 250 } = {}) {
  check();
  let state = await settleCallPrompt(page, { check, timeout, interval, endCurrentCall });
  check(); assertCallAvailable(state);
  await authorize(); check();
  if (state.searching && !state.partnerConnected) return state; // Do not restart an active search.
  if (state.partnerConnected && !endCurrentCall) return state; // Repeated /join keeps the current partner.
  if (state.partnerConnected) {
    const end = await control(page, endName);
    check(); await end.click({ timeout: 5000 }); check();
    const deadline = Date.now() + timeout;
    do {
      state = await page.evaluate(readAudioCallState);
      check();
      if (state.attention && !state.restricted && !state.verification) {
        state = await settleCallPrompt(page, { check, timeout, interval, endCurrentCall });
      }
      assertCallAvailable(state);
      if (!state.partnerConnected) break;
      await new Promise(resolve => setTimeout(resolve, interval));
    } while (Date.now() < deadline);
    if (state.partnerConnected || state.attention) throw searchError('next-confirm');
  }
  check(); assertCallAvailable(state);
  if (state.searching) return state; // Native End may already have started the next search.
  const { button: start, state: observed } = await waitForStartControl(page, { check, timeout: startTimeout, interval });
  if (!start) return observed;
  await authorize(); check();
  if (!startSearch) return observed;
  await start.click({ timeout: 5000 });
  return waitForAudioSearch(page, { check, timeout, interval });
}
