import { readAudioCallState, waitForAudioSearch, assertCallAvailable } from './call-state.js';
import { searchError } from './search-error.js';
import { waitForStartControl } from './start-controls.js';
import { endName, confirmEndName, labelledCallControls } from './native-controls.js';

// Use only visible, enabled controls with an explicit call-related label.
// An unknown layout fails in place instead of opening another registration.
async function control(scope, name) {
  const matches = await labelledCallControls(scope, name);
  if (matches.length !== 1) throw searchError('next-control');
  return matches[0];
}

const isEndConfirmation = text =>
  /^(?=[\s\S]*(?:завершить|закончить)\s+(?:разговор|беседу|общение))(?=[\s\S]*(?:уверены|действительно))/i.test(text.trim()) ||
  /^(?=[\s\S]*(?:are you sure|confirm))(?=[\s\S]*(?:end|disconnect))(?=[\s\S]*(?:call|conversation))/i.test(text.trim()) ||
  /^(?=[\s\S]*(?:әңгім|сөйлесу|сұхбат|қоңырау))(?=[\s\S]*аяқта)(?=[\s\S]*(?:сенімді|растау))/iu.test(text.trim());

export async function advanceAudioCall(page, { check = () => {}, authorize, endCurrentCall = true,
  timeout = 15000, startTimeout = 30000, interval = 250 } = {}) {
  check();
  let state = await page.evaluate(readAudioCallState);
  check(); assertCallAvailable(state);
  await authorize(); check();
  if (state.searching && !state.partnerConnected) return state; // Do not restart an active search.
  if (state.partnerConnected && !endCurrentCall) return state; // Repeated /join keeps the current partner.
  if (state.partnerConnected) {
    const end = await control(page, endName);
    check(); await end.click({ timeout: 5000 }); check();
    const deadline = Date.now() + timeout;
    let confirmed = false;
    do {
      state = await page.evaluate(readAudioCallState);
      check();
      if (state.attention && !state.restricted && !state.verification) {
        const popups = page.locator('.swal2-popup');
        const visible = [];
        for (let i = 0; i < await popups.count(); i++) {
          const popup = popups.nth(i);
          if (await popup.isVisible()) visible.push(popup);
        }
        if (visible.length !== 1) {
          // A closing popup can disappear between the state read and lookup.
          state = await page.evaluate(readAudioCallState);
          check(); assertCallAvailable(state);
          if (!state.partnerConnected) break;
          await new Promise(resolve => setTimeout(resolve, interval));
          continue;
        }
        const popup = visible[0];
        const text = await popup.innerText({ timeout: 3000 });
        // Only the ordinary end-call confirmation opened by our own End click.
        if (isEndConfirmation(text)) {
          if (!confirmed) {
            const yes = await control(popup, confirmEndName);
            check(); await yes.click({ timeout: 5000 }); check(); confirmed = true;
            // Read state immediately after confirming — avoids relying on the
            // do…while condition being checked before the deadline expires.
            state = await page.evaluate(readAudioCallState); check();
            if (!state.partnerConnected && !state.attention) break;
          }
          // The native popup may remain visible during its closing animation.
          // Wait for it to disappear without answering the same prompt twice.
          await new Promise(resolve => setTimeout(resolve, interval));
          continue;
        }
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
  await start.click({ timeout: 5000 });
  return waitForAudioSearch(page, { check, timeout, interval });
}
