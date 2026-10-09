import { readAudioCallState } from './call-state.js';
import { confirmAudioToken } from './live-session.js';

// Read native flags again at the failure boundary, rather than reuse registration's snapshot.
export async function observeAudioSession(page, token, { stage, check = () => {} } = {}) {
  check();
  const callState = await page.evaluate(readAudioCallState);
  check();
  const identity = await page.evaluate(confirmAudioToken, { token, timeout: 1 });
  check();
  return { stage, callState, authorizationDiagnostics: identity.diagnostics || null, authorizationReason: identity.reason };
}
