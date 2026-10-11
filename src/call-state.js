import { searchError } from './search-error.js';
import { authorizationError } from './live-session.js';

export function assertCallAvailable(state) {
  if (state.verification) throw authorizationError('verification-required');
  if (state.restricted) throw authorizationError('native-restriction');
  if (state.attention) throw searchError('attention');
}

// Serialized into the audio page. No partner identities or chat content leave it.
export function readAudioCallState() {
  const store = Array.from(document.querySelectorAll('*')).map(el => el.__vue__?.$store)
    .find(store => store?.state?.user && store.state.system);
  const state = store?.state;
  const visible = selector => Array.from(document.querySelectorAll(selector)).some(el => {
    if (!el?.isConnected) return false;
    if (el.checkVisibility) return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const style = getComputedStyle(el);
    return !!(el.getClientRects().length && style.display !== 'none' && style.opacity !== '0' &&
      !['hidden', 'collapse'].includes(style.visibility));
  });
  const verification = !!(state?.system.captchaRequired || state?.system.hcaptchaRequired);
  const restricted = !!state?.system.forceDisconnectReason || visible('#mask_bad') || visible('#mask_bad_inet') || visible('.swal2-popup.banPopup');
  const attention = visible('.swal2-popup');
  const activeCall = state?.chat?.activeConnectionId != null;
  const callEnded = !activeCall && visible('.callScreen__finishText');
  // Nekto's Searching component sets isSearching=true, then navigates to /peer
  // without clearing it. It remains true after peer-disconnect. The call screen
  // and its finished state therefore take precedence over that historical flag.
  const callScreen = callEnded || /#\/peer(?:[/?]|$)/.test(location.hash);
  const searching = !activeCall && !callScreen && (!!state?.user.isSearching ||
    /#\/searching(?:[/?]|$)/.test(location.hash) || visible('.chat-step.scan .search_loader'));
  const partnerConnected = activeCall && state?.system.isAuth === true &&
    state?.system.socketConnected === true && !verification && !restricted && !attention;
  const phase = verification ? 'verification required' : restricted ? 'restricted' : attention ? 'awaiting a website prompt' :
    partnerConnected ? 'partner connected' : callEnded ? 'call ended; ready to search' :
    searching ? 'searching for a partner' : visible('#searchCompanyBtn') ? 'ready to search' : 'idle/loading';
  return { phase, searching, partnerConnected, callEnded, verification, restricted, attention };
}

export async function waitForAudioSearch(page, { timeout = 15000, interval = 250, check = () => {} } = {}) {
  const deadline = Date.now() + timeout;
  do {
    check();
    const state = await page.evaluate(readAudioCallState);
    check();
    if (state.searching || state.partnerConnected || state.verification || state.restricted || state.attention) return state;
    await new Promise(resolve => setTimeout(resolve, interval));
  } while (Date.now() < deadline);
  throw searchError('confirm');
}
