import test from 'node:test';
import assert from 'node:assert/strict';
import { observeAudioSession } from '../src/session-observation.js';
import { readAudioCallState } from '../src/call-state.js';
import { confirmAudioToken } from '../src/live-session.js';
import { statusReply } from '../src/status-reply.js';

test('verification after successful registration replaces stale diagnostics and preserves acceptance', async () => {
  const page = { evaluate: async (fn, args) => {
    if (fn === readAudioCallState) return { phase: 'verification required', verification: true };
    assert.equal(fn, confirmAudioToken); assert.equal(args.timeout, 1);
    return { ok: false, reason: 'verification-required', diagnostics: { savedTokenMatches: true, liveTokenMatches: true,
      authenticated: true, socketConnected: true, identityPresent: true, captcha: false, hcaptcha: true,
      restricted: false, registrationError: 0 } };
  } };
  const observed = await observeAudioSession(page, 'fixture-token', { stage: 'before-start' });
  assert.equal(observed.authorizationDiagnostics.hcaptcha, true);
  assert.equal(observed.authorizationDiagnostics.liveTokenMatches, true);
  const reply = statusReply({ voice: 'ready', token: 'fixture-token', queue: { received: 0, nonSilent: 0 },
    status: { active: false, authorization: 'native-session-confirmed', observedStage: observed.stage, ...observed } });
  assert(reply.content.includes('Last token authorization: native-session-confirmed'));
  assert(reply.content.includes('before-start; captcha=false; hcaptcha=true; verification=true'));
});

test('session observation cancels before using a replacement page', async () => {
  let evaluated = 0;
  await assert.rejects(observeAudioSession({ evaluate: async () => evaluated++ }, 'fixture-token', {
    check() { throw Error('cancelled'); },
  }), /cancelled/);
  assert.equal(evaluated, 0);
});
