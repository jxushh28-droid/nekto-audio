import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { installBrowserRelay, inspectBrowserMicrophone } from './browser-init.js';
import { installAntiDetect } from './anti-detect.js';
import { searchError } from './search-error.js';
import { audioClientReady, confirmAudioToken, authorizationError } from './live-session.js';
import { readAudioCallState, waitForAudioSearch } from './call-state.js';
import { readAudioPrompt } from './audio-prompt.js';
import { advanceAudioCall } from './call-controls.js';
import { observeAudioSession } from './session-observation.js';
import { tokenExtensionScript, browserLaunchOptions, generateFingerprint, fpSeed } from './token-extension.js';
import { waitForStartControl, inspectStartControls } from './start-controls.js';

import { attachNektoDiagnostics, installVerificationObserver, sanitizeVerificationReport } from './network-diagnostics.js';

// profile-lock.js no longer needed: no persistent browser profile

import { writeSilentMicrophone } from './silent-microphone.js';

import { updateProtocolSummary } from './protocol-diagnostics.js';

export const NEKTO_URL = 'https://nekto-me.kz/audiochat#/';

export class NektoBrowser {
  constructor(onAudio, directory = process.env.DATA_DIR || './data') {
    this.onAudio = onAudio; this.page = null; this.browser = null; this.context = null;
    this.generation = 0; this.lastFailure = null; this.authorizationDiagnostics = null; this.callState = null; this.promptInfo = null; this.microphone = null;
    this.forwarding = false;
    this.protocolDiagnostics = null;
    this.monitorTimer = null; this.monitorVersion = 0;
    this.authorization = null; this.observedStage = null;
    this.controlDiagnostics = null;
    // No persistent profile path — each session gets a fresh browser.newContext() (incognito).
    // This prevents ban fingerprints from accumulating in IndexedDB / localStorage across restarts.
    this.microphonePath = resolve(directory, 'silent-microphone.wav');
  }

  stopSessionMonitor() {
    this.monitorVersion++;
    clearTimeout(this.monitorTimer);
    this.monitorTimer = null;
  }
  startSessionMonitor(page, token, generation = this.generation) {
    this.stopSessionMonitor();
    const version = this.monitorVersion;
    const current = () => version === this.monitorVersion && generation === this.generation &&
      this.page === page && !page.isClosed();
    const check = () => { if (!current()) throw new Error('Nekto monitoring was stopped.'); };
    const tick = async () => {
      if (!current()) return;
      try {
        const observed = await observeAudioSession(page, token, { stage: 'monitor', check });
        const captureError = await page.evaluate(() => window.__nektoRelay?.error);
        check();
        this.callState = observed.callState;
        this.authorizationDiagnostics = observed.authorizationDiagnostics;
        const forwarding = canForwardAudio(observed, captureError);
        if (forwarding !== this.forwarding) {
          console.log(JSON.stringify({ event: 'nekto_relay_transition',
            forwarding, phase: this.callState.phase, authorization: observed.authorizationReason }));
        }
        this.forwarding = forwarding;
        if (forwarding) {
          this.authorization = observed.authorizationReason;
          // A challenge may clear while the original search remains active.
          if (this.lastFailure?.code === 'NEKTO_VERIFICATION') this.lastFailure = null;
        }
      } catch {
        if (current()) this.forwarding = false;
      } finally {
        if (current()) {
          this.monitorTimer = setTimeout(tick, 500);
          this.monitorTimer.unref?.();
        }
      }
    };
    this.monitorTimer = setTimeout(tick, 500);
    this.monitorTimer.unref?.();
  }

  async launch(token = '') {
    // Launch the browser process once and keep it alive across sessions.
    // Each openSession() creates a fresh incognito context (browser.newContext()) so
    // there is no localStorage / IndexedDB / cookie accumulation between sessions.
    if (this.browser?.isConnected()) return this.browser;
    await writeSilentMicrophone(this.microphonePath);
    this.browser = await chromium.launch(browserLaunchOptions(this.microphonePath));
    return this.browser;
  }
  async search(token) {
    if (this.page && !this.page.isClosed()) return this.next(token, { endCurrentCall: false });
    return this.openSession(token);
  }
  async openSession(token) {
    this.stopSessionMonitor();
    this.forwarding = false;
    const generation = ++this.generation;
    const previous = this.context;
    this.page = null; this.context = null; this.lastFailure = null; this.authorizationDiagnostics = null; this.callState = null; this.promptInfo = null; this.microphone = null;
    this.authorization = null; this.observedStage = null;
    this.controlDiagnostics = null;
    this.protocolDiagnostics = null;
    const check = () => {
      if (generation !== this.generation) throw new Error('Nekto search was stopped.');
    };
    let context;
    let stage = 'setup';
    try {
      if (previous) await previous.close().catch(() => {});
      check();
      // Get (or start) the browser process, then open a fresh incognito context.
      // Each session starts completely clean — no stored cookies, localStorage or
      // IndexedDB from previous sessions. Token + fingerprint are injected via
      // addInitScript below instead of a Chrome extension.
      const browser = await this.launch(token);
      check();
      const { userAgent } = generateFingerprint(token);
      context = await browser.newContext({ userAgent });
      await context.grantPermissions(['microphone'], { origin: new URL(NEKTO_URL).origin });
      // Spoof Origin to match what a real browser user on nekto.me sends.
      await context.setExtraHTTPHeaders({ 'origin': 'https://nekto-me.kz' });
      check();
      this.context = context;
      const page = await context.newPage();
      check();
      this.page = page;
      await attachNektoDiagnostics(page, token, {
        current: () => generation === this.generation && this.page === page,
        onProtocol: report => {
          this.protocolDiagnostics = updateProtocolSummary(this.protocolDiagnostics, report);
          // Log register/registered frames so we can see in Railway logs whether the
          // right token is being sent and whether the server accepted it.
          if (report.direction === 'encrypt' && report.type === 'register') {
            console.log(JSON.stringify({ event: 'nekto_register_sent',
              credentialField: report.credentialField, credentialMatches: report.credentialMatches,
              hasGumHash: report.hasGumHash, hasFpt: report.hasFpt,
              hasCanvas: report.hasCanvas, hasPlugins: report.hasPlugins, hasDuration: report.hasDuration }));
          }
          if (report.direction === 'decrypt' && report.type === 'registered') {
            console.log(JSON.stringify({ event: 'nekto_register_response', success: report.success }));
          }
          // Log captcha-request but do NOT stop the session here.
          // Stopping via this async path races with the normal flow and cancels the
          // session with no lastFailure, making it look like a silent clean stop to the user.
          // The normal flow already handles captcha: waitForStartControl polls assertCallAvailable
          // which throws NEKTO_VERIFICATION if the Vue store sets captchaRequired=true, and
          // finishSearch checks state.verification after searching starts. Both paths set
          // lastFailure so /status shows the real cause. If captcha-request arrives after
          // searching is confirmed (finishSearch already returned), the session stays up and
          // may still route a partner.
          if (report.direction === 'decrypt' && report.type === 'captcha-request') {
            console.log(JSON.stringify({ event: 'nekto_captcha_request_received', action: 'session_continues',
              captchaVariant: report.captchaVariant || 'unknown', captchaFields: report.captchaFields || '' }));
          }
        },
      });
      await page.exposeBinding('pushNektoAudio', ({ frame }, base64) => {
        if (this.forwarding && generation === this.generation && frame === page.mainFrame() &&
            new URL(frame.url()).origin === new URL(NEKTO_URL).origin) this.onAudio(base64);
      });
      await page.addInitScript(installBrowserRelay, { origin: new URL(NEKTO_URL).origin });
      // Token + fingerprint injection (replaces the Chrome extension approach).
      // tokenExtensionScript writes authToken + cookiesAccepted to localStorage at
      // document_start and applies navigator/screen/Intl spoof overrides.
      await page.addInitScript({ content: tokenExtensionScript(token) });
      // Anti-detection: WebGL/Canvas/WebGPU/Client Hints spoof + gumHash bypass + tab-conflict auto-click.
      // fpSeed  = FNV-1a(token) → LCG seed for canvas pixel noise (stable per token, different per token).
      // gumHash = sha256(token+'gum') → replaces the getUserMedia stream hash (fake mic produces bot hash).
      await page.addInitScript(installAntiDetect, {
        fptHash: null, // fpt is NOT replaced — incognito context gives a fresh FingerprintJS ID each session
        fpSeed: fpSeed(token || ''),
        gumHash: createHash('sha256').update((token || '') + '-gum').digest('hex'),
      });
      page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
      stage = 'load';
      // Fresh incognito context — no storage clear needed (context.newContext() starts empty).
      check();
      const response = await page.goto(NEKTO_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (response && response.status() >= 400) throw searchError('load');
      // Confirm the token landed in BOTH localStorage AND the hydrated Vuex store.
      // localStorage alone isn't enough — nekto authenticates off the Vuex state that
      // vuex-persistedstate restores from storage_audio_v2 at store-creation time. If
      // storeAuthToken is empty while lsAuthToken is set, the init script wrote too late
      // (after the store initialised) and the session is unauthenticated → blocked.
      const injection = await page.evaluate(key => {
        const out = { lsAuthToken: false, storeAuthToken: null };
        try {
          const saved = JSON.parse(localStorage.getItem(key) || '{}');
          out.lsAuthToken = typeof saved?.user?.authToken === 'string' && saved.user.authToken.length > 0;
        } catch (_) {}
        try {
          // Reach the Vuex store via the root Vue instance mounted on #app.
          const root = document.querySelector('#app')?.__vue__;
          const tok = root?.$store?.state?.user?.authToken;
          out.storeAuthToken = typeof tok === 'string' ? tok.length > 0 : null;
        } catch (_) {}
        return out;
      }, 'storage_audio_v2');
      console.log(JSON.stringify({ event: 'nekto_injection_check', ...injection }));
      check();
      this.microphone = await page.evaluate(inspectBrowserMicrophone);
      check();
      if (this.microphone.permission !== 'granted' || !this.microphone.inputs) throw searchError('microphone');
      check();
      stage = 'authorize';
      try { await page.waitForFunction(audioClientReady, null, { timeout: 20000 }); }
      catch {
        check();
        const observed = await page.evaluate(confirmAudioToken, { token, timeout: 1 });
        check();
        this.authorizationDiagnostics = observed.diagnostics || null;
        if (!observed.ok) throw authorizationError(observed.reason === 'authorization-timeout' ? 'client-not-ready' : observed.reason);
      }
      check();
      const verification = await page.evaluate(installVerificationObserver, { origin: new URL(NEKTO_URL).origin });
      check();
      if (verification) console.log(JSON.stringify({ event: 'nekto_verification_baseline', ...sanitizeVerificationReport(verification) }));
      const authorization = await page.evaluate(confirmAudioToken, { token });
      check();
      this.authorizationDiagnostics = authorization.diagnostics || null;
      console.log(JSON.stringify({ event: 'nekto_audio_registration', result: authorization.reason, ...this.authorizationDiagnostics }));
      if (!authorization.ok) throw authorizationError(authorization.reason);
      this.authorization = authorization.reason;
      check();
      await page.evaluate(reason => { window.__nektoRelay.authorization = reason; }, authorization.reason);
      const initial = await this.recordSessionState(page, token, 'before-start', check);
      if (initial.attention || initial.verification || initial.restricted) return await this.finishSearch(page, token, check, 'before-start');
      stage = 'control';
      const { button } = await waitForStartControl(page, { check });
      if (!button) return await this.finishSearch(page, token, check, 'already-searching');
      const verificationText = page.getByText(/verify you are human|checking your browser|unusual traffic/i);
      for (let i = 0; i < await verificationText.count(); i++) {
        if (await verificationText.nth(i).isVisible()) throw authorizationError('verification-required');
      }
      const captureError = await page.evaluate(() => window.__nektoRelay?.error);
      if (captureError) throw new Error(captureError);
      const identity = await page.evaluate(confirmAudioToken, { token, timeout: 3000 });
      check();
      this.authorizationDiagnostics = identity.diagnostics || null;
      if (!identity.ok) throw authorizationError(identity.reason);
      check();
      stage = 'click';
      await button.click({ timeout: 5000 });
      stage = 'confirm';
      return await this.finishSearch(page, token, check, 'after-start');
    } catch (error) {
      const cancelled = generation !== this.generation;
      if (!cancelled) {
        const page = this.page;
        if (page && !page.isClosed()) {
          await this.recordSessionState(page, token, `${stage}-failure`, check).catch(() => {});
          this.controlDiagnostics = await inspectStartControls(page, { token }).catch(() => null);
          if (this.callState?.attention) this.promptInfo = await page.evaluate(readAudioPrompt).catch(() => null);
          console.warn(JSON.stringify({ event: 'nekto_start_failed', stage, errorType: error.name,
            ...this.controlDiagnostics }));
        }
        const keepSession = page && !page.isClosed() && (this.callState?.verification ||
          this.callState?.restricted || this.callState?.attention || ['control', 'click', 'confirm'].includes(stage));
        // Preserve the native page after a failed Start or website challenge.
        // Retrying /join must not create another registration or erase evidence.
        if (!keepSession) await this.stop();
      }
      else {
        await context?.close().catch(() => {});
        if (this.context === context) { this.page = null; this.context = null; }
      }
      if (cancelled) throw new Error('Nekto search was stopped.');
      const known = ['Nekto is asking for browser verification. Automatic search stopped.',
        'Audio capture initialization failed.', 'Remote audio capture failed.'];
      const failure = known.includes(error.message) || /^NEKTO_/.test(error.code || '')
        ? error : searchError(stage);
      this.lastFailure = { code: failure.code || 'NEKTO_CAPTURE_OR_VERIFICATION', message: failure.message };
      throw failure;
    } finally {
      if (generation === this.generation && this.page && !this.page.isClosed()) {
        this.startSessionMonitor(this.page, token, generation);
      }
    }
  }
  async next(token, { endCurrentCall = true } = {}) {
    const page = this.page;
    if (!page || page.isClosed()) return this.search(token);
    const generation = this.generation;
    const check = () => {
      if (generation !== this.generation || this.page !== page) throw new Error('Nekto search was stopped.');
    };
    this.stopSessionMonitor();
    this.forwarding = false;
    try {
      await advanceAudioCall(page, { check, endCurrentCall, authorize: async () => {
        const identity = await page.evaluate(confirmAudioToken, { token, timeout: 3000 });
        check(); this.authorizationDiagnostics = identity.diagnostics || null;
        if (!identity.ok) throw authorizationError(identity.reason);
      } });
      return await this.finishSearch(page, token, check, endCurrentCall ? 'next-confirmation' : 'resume-confirmation');
    } catch (error) {
      check();
      await this.recordSessionState(page, token, 'next-failure', check).catch(() => {});
      this.controlDiagnostics = await inspectStartControls(page, { token }).catch(() => null);
      check();
      this.promptInfo = this.callState?.attention ? await page.evaluate(readAudioPrompt).catch(() => null) : null;
      const failure = /^NEKTO_/.test(error.code || '') ? error : searchError('next-control');
      this.lastFailure = { code: failure.code, message: failure.message };
      console.warn(JSON.stringify({ event: endCurrentCall ? 'nekto_next_failed' : 'nekto_resume_failed',
        code: failure.code, ...this.callState, ...this.controlDiagnostics }));
      // Keep the native connection and any restriction visible. Never retry by re-registering.
      throw failure;
    } finally {
      if (generation === this.generation && this.page === page && !page.isClosed()) {
        this.startSessionMonitor(page, token, generation);
      }
    }
  }
  async recordSessionState(page, token, stage, check) {
    const observed = await observeAudioSession(page, token, { stage, check });
    this.callState = observed.callState; this.authorizationDiagnostics = observed.authorizationDiagnostics; this.observedStage = stage;
    console.log(JSON.stringify({ event: 'nekto_session_state', stage, ...this.callState, ...this.authorizationDiagnostics }));
    return this.callState;
  }
  async finishSearch(page, token, check, stage = 'after-start') {
    this.callState = await waitForAudioSearch(page, { check });
    await this.recordSessionState(page, token, stage, check);
    if (this.callState.verification) throw authorizationError('verification-required');
    if (this.callState.restricted) throw authorizationError('native-restriction');
    if (this.callState.attention) {
      this.promptInfo = await page.evaluate(readAudioPrompt);
      check();
      throw searchError(this.promptInfo.category === 'microphone-denied' || this.promptInfo.category === 'microphone-error'
        ? 'microphone' : 'attention');
    }
    check();
    const identity = await page.evaluate(confirmAudioToken, { token, timeout: 3000 });
    check();
    this.authorizationDiagnostics = identity.diagnostics || null;
    if (!identity.ok) throw authorizationError(identity.reason);
    const captureError = await page.evaluate(() => window.__nektoRelay?.error);
    check();
    if (captureError) throw Object.assign(new Error(captureError), { code: 'NEKTO_CAPTURE' });
    this.promptInfo = null; this.lastFailure = null; this.forwarding = true;
    this.authorization = identity.reason;
    this.controlDiagnostics = null;
    return this.callState.partnerConnected
      ? 'Connected to a Nekto partner. Incoming audio is relayed to this voice channel.'
      : 'Searching on Nekto. Incoming audio will play here when someone connects.';
  }
  async status(token) {
    const page = this.page;
    if (!page || page.isClosed()) return { active: false, protocolDiagnostics: this.protocolDiagnostics, authorization: this.authorization, observedStage: this.observedStage, controlDiagnostics: this.controlDiagnostics, lastFailure: this.lastFailure, authorizationDiagnostics: this.authorizationDiagnostics, callState: this.callState, promptInfo: this.promptInfo, microphone: this.microphone };
    this.callState = await page.evaluate(readAudioCallState);
    if (token) {
      const identity = await page.evaluate(confirmAudioToken, { token, timeout: 1 });
      this.authorizationDiagnostics = identity.diagnostics || null;
    }
    this.promptInfo = this.callState.attention ? await page.evaluate(readAudioPrompt) : null;
    const status = await page.evaluate(() => ({ active: true, ...window.__nektoRelay }));
    console.log(JSON.stringify({ event: 'nekto_audio_status', ...this.callState,
      browserFrames: status.frames || 0, peers: status.peers || 0, peerStates: status.peerStates || [],
      iceStates: status.iceStates || [], trackEvents: status.trackEvents || 0, capturedTracks: status.tracks || 0,
      inboundPackets: status.inboundPackets || 0, inboundBytes: status.inboundBytes || 0,
      audioState: status.audioState || 'unknown', bindingErrors: status.bindingErrors || 0 }));
    return { ...status, protocolDiagnostics: this.protocolDiagnostics, forwarding: this.forwarding, authorization: this.authorization || status.authorization, observedStage: this.observedStage, controlDiagnostics: this.controlDiagnostics, lastFailure: this.lastFailure, authorizationDiagnostics: this.authorizationDiagnostics, callState: this.callState, promptInfo: this.promptInfo, microphone: this.microphone };
  }
  async screenshot() {
    const page = this.page;
    if (!page || page.isClosed()) return null;
    return page.screenshot({ type: 'jpeg', quality: 80, fullPage: false });
  }
  async stop() {
    this.stopSessionMonitor();
    this.generation++;
    this.forwarding = false;
    this.protocolDiagnostics = null;
    const context = this.context;
    this.page = null; this.context = null;
    // Keep this.browser alive — it's reused across sessions (newContext() per session).
    if (context) await context.close().catch(() => {});
  }
  async close() {
    await this.stop();
    const browser = this.browser;
    this.browser = null;
    await browser?.close().catch(() => {});
  }
}


export function canForwardAudio(observed, captureError) {
  const state = observed.callState;
  const d = observed.authorizationDiagnostics;
  return !!(state && d && !captureError &&
    !state.verification && !state.restricted && !state.attention &&
    (state.searching || state.partnerConnected) &&
    observed.authorizationReason === 'native-session-confirmed' &&
    d.savedTokenMatches && d.liveTokenMatches && d.identityPresent &&
    d.authenticated && d.socketConnected && !d.captcha && !d.hcaptcha &&
    !d.restricted && !d.registrationError);
}
