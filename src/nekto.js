import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { installBrowserRelay, inspectBrowserMicrophone } from './browser-init.js';
import { searchError } from './search-error.js';
import { audioClientReady, confirmAudioToken, authorizationError } from './live-session.js';
import { readAudioCallState, waitForAudioSearch } from './call-state.js';
import { readAudioPrompt } from './audio-prompt.js';
import { advanceAudioCall } from './call-controls.js';
import { waitForVerificationWidget } from './verification-readiness.js';
import { observeAudioSession } from './session-observation.js';
import { tokenExtensionScript, browserLaunchOptions } from './token-extension.js';
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
    this.entryRetryUsed = false; this.entryRetryPromise = null; this.searchIntent = false;
    this.partnerSeen = false; this.callAdvancePromise = null;
    this.manualSearch = process.env.NEKTO_MANUAL_SEARCH === '1';
    this.waitingForManualSearch = false;
    this.authorization = null; this.observedStage = null;
    this.controlDiagnostics = null;
    // Each session has its own non-persistent browser context.
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
        if (observed.callState.verification && this.searchIntent && !this.entryRetryUsed && !this.manualSearch) {
          this.forwarding = false;
          try { await this.retryFromEntry(page, token, check); }
          catch (error) {
            if (current()) {
              await this.recordSessionState(page, token, 'retry-failure', check).catch(() => {});
              if (!current()) return;
              this.lastFailure = { code: /^NEKTO_/.test(error.code || '') ? error.code : 'NEKTO_PAGE_LOAD',
                message: /^NEKTO_/.test(error.code || '') ? error.message : searchError('load').message };
            }
          }
          return;
        }
        if (observed.callState.partnerConnected) this.partnerSeen = true;
        else if (observed.callState.searching && !observed.callState.attention) this.partnerSeen = false;
        const prompt = observed.callState.attention ? await page.evaluate(readAudioPrompt) : null;
        check();
        const callPrompt = ['end-confirm', 'call-ended'].includes(prompt?.category) && !prompt.fieldCount;
        const ended = observed.callState.callEnded || (this.partnerSeen && !observed.callState.attention);
        if (this.searchIntent && !observed.callState.verification && !observed.callState.restricted &&
            !observed.callState.searching && !observed.callState.partnerConnected && (callPrompt || ended)) {
          this.forwarding = false;
          const advance = this.advanceSearch(page, token, check);
          this.callAdvancePromise = advance;
          try { await advance; }
          catch { if (current()) this.searchIntent = false; } // Fail in place, without repeated prompt clicks.
          finally { if (this.callAdvancePromise === advance) this.callAdvancePromise = null; }
          return;
        }
        if (!observed.callState.searching && !observed.callState.partnerConnected &&
            !observed.callState.verification && !observed.callState.attention) this.searchIntent = false;
        const forwarding = canForwardAudio(observed, captureError);
        if (this.manualSearch && forwarding) {
          this.waitingForManualSearch = false;
          this.searchIntent = true;
        }
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
    // Each openSession() creates an isolated incognito context.
    if (this.browser?.isConnected()) return this.browser;
    await writeSilentMicrophone(this.microphonePath);
    const opts = browserLaunchOptions(this.microphonePath);
    try {
      this.browser = await chromium.launch(opts);
    } catch (error) {
      // Real Chrome (channel: 'chrome') may not be installed; fall back to the
      // bundled Chromium so the bot still runs.
      if (opts.channel === 'chrome' && /not found|does(?:n't| not) exist/i.test(error?.message || '')) {
        console.warn(JSON.stringify({ event: 'nekto_chrome_unavailable',
          channel: opts.channel, fallback: 'chromium' }));
        this.browser = await chromium.launch({ ...opts, channel: 'chromium' });
      } else throw error;
    }
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
    this.entryRetryUsed = false; this.searchIntent = true;
    this.entryRetryPromise = null; this.partnerSeen = false; this.callAdvancePromise = null;
    this.waitingForManualSearch = false;
    const check = () => {
      if (generation !== this.generation) throw new Error('Nekto search was stopped.');
    };
    let context;
    let stage = 'setup';
    try {
      if (previous) await previous.close().catch(() => {});
      check();
      // Use the native UA, Client Hints, GPU, plugins, audio and screen.
      // Chromium supplies the correct Origin on the actual .kz page; global
      // extra headers would also alter Google/CAPTCHA and other-site requests.
      const browser = await this.launch(token);
      check();
      context = await browser.newContext({ viewport: null });
      await context.grantPermissions(['microphone'], { origin: new URL(NEKTO_URL).origin });
      check();
      this.context = context;
      const page = await context.newPage();
      check();
      this.page = page;
      await attachNektoDiagnostics(page, token, {
        protocol: process.env.NEKTO_PROTOCOL_DIAGNOSTICS === '1',
        current: () => generation === this.generation && this.page === page,
        onProtocol: report => {
          this.protocolDiagnostics = updateProtocolSummary(this.protocolDiagnostics, report);
          // Log register/registered frames so we can see in Railway logs whether the
          // right token is being sent and whether the server accepted it.
          if (report.direction === 'encrypt' && report.type === 'register') {
            console.log(JSON.stringify({ event: 'nekto_register_sent',
              credentialField: report.credentialField, credentialMatches: report.credentialMatches }));
          }
          if (report.direction === 'decrypt' && report.type === 'registered') {
            console.log(JSON.stringify({ event: 'nekto_register_response', success: report.success }));
          }
          // Observe protocol messages here; native state checks own the single
          // entry-page retry, avoiding an independent restart racing with Start.
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
      // Guard every navigation/frame: only the Nekto origin receives the token.
      await page.addInitScript({ content: tokenExtensionScript(token) });
      page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
      return await this.loadAndSearch(page, token, check, value => { stage = value; });
    } catch (error) {
      if (generation === this.generation && error.code === 'NEKTO_VERIFICATION' && !this.entryRetryUsed && !this.manualSearch && this.page) {
        try { return await this.retryFromEntry(this.page, token, check, value => { stage = value; }); }
        catch (retryError) { error = retryError; }
      }
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
  async loadAndSearch(page, token, check, setStage = () => {}) {
    setStage('load'); check();
    let response = await page.goto(NEKTO_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // The entry URL can be a same-document hash navigation. Reload in that
    // case so the native client actually initializes again, in the same context.
    if (!response) { check(); response = await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }); }
    check();
    if (response && response.status() >= 400) throw searchError('load');
    const injection = await page.evaluate(key => {
      let lsAuthToken = false, storeAuthToken = null;
      try {
        const stored = JSON.parse(localStorage.getItem(key) || '{}')?.user?.authToken;
        lsAuthToken = typeof stored === 'string' && !!stored;
      } catch {}
      const token = document.querySelector('#app')?.__vue__?.$store?.state?.user?.authToken;
      if (typeof token === 'string') storeAuthToken = !!token;
      return { lsAuthToken, storeAuthToken };
    }, 'storage_audio_v2');
    check(); console.log(JSON.stringify({ event: 'nekto_injection_check', ...injection }));
    this.microphone = await page.evaluate(inspectBrowserMicrophone); check();
    if (this.microphone.permission !== 'granted' || !this.microphone.inputs) throw searchError('microphone');
    setStage('authorize');
    try { await page.waitForFunction(audioClientReady, null, { timeout: 20000 }); }
    catch {
      check();
      const observed = await page.evaluate(confirmAudioToken, { token, timeout: 1 }); check();
      this.authorizationDiagnostics = observed.diagnostics || null;
      if (!observed.ok) throw authorizationError(observed.reason === 'authorization-timeout' ? 'client-not-ready' : observed.reason);
    }
    check();
    const verification = await page.evaluate(installVerificationObserver, { origin: new URL(NEKTO_URL).origin }); check();
    if (verification) console.log(JSON.stringify({ event: 'nekto_verification_baseline', ...sanitizeVerificationReport(verification) }));
    const authorization = await page.evaluate(confirmAudioToken, { token }); check();
    this.authorizationDiagnostics = authorization.diagnostics || null;
    console.log(JSON.stringify({ event: 'nekto_audio_registration', result: authorization.reason, ...this.authorizationDiagnostics }));
    if (!authorization.ok) throw authorizationError(authorization.reason);
    this.authorization = authorization.reason;
    await page.evaluate(reason => { window.__nektoRelay.authorization = reason; }, authorization.reason); check();
    const initial = await this.recordSessionState(page, token, 'before-start', check);
    if (initial.attention || initial.verification || initial.restricted) return this.finishSearch(page, token, check, 'before-start');
    setStage('control');
    const { button } = await waitForStartControl(page, { check });
    if (!button) return this.finishSearch(page, token, check, 'already-searching');
    const verificationText = page.getByText(/verify you are human|checking your browser|unusual traffic/i);
    for (let i = 0; i < await verificationText.count(); i++) {
      if (await verificationText.nth(i).isVisible()) throw authorizationError('verification-required');
    }
    const captureError = await page.evaluate(() => window.__nektoRelay?.error); check();
    if (captureError) throw new Error(captureError);
    const identity = await page.evaluate(confirmAudioToken, { token, timeout: 3000 }); check();
    this.authorizationDiagnostics = identity.diagnostics || null;
    if (!identity.ok) throw authorizationError(identity.reason);
    if (this.manualSearch) return this.awaitManualSearch(page, token, check);
    setStage('click'); await button.click({ timeout: 5000 }); check();
    setStage('confirm');
    return this.finishSearch(page, token, check, 'after-start');
  }
  async retryFromEntry(page, token, check, setStage) {
    check();
    if (this.manualSearch || this.entryRetryUsed || page !== this.page || new URL(page.url()).origin !== new URL(NEKTO_URL).origin) {
      throw authorizationError('verification-required');
    }
    this.entryRetryUsed = true;
    this.forwarding = false; this.protocolDiagnostics = null;
    const retry = (async () => {
      setStage?.('captcha-loading');
      console.log(JSON.stringify({ event: 'nekto_verification_wait', action: 'wait-for-widget' }));
      const readiness = await waitForVerificationWidget(page, { check });
      check();
      if (page !== this.page || new URL(page.url()).origin !== new URL(NEKTO_URL).origin) {
        throw authorizationError('verification-required');
      }
      if (readiness === 'cleared') {
        await advanceAudioCall(page, { check, endCurrentCall: false, authorize: () => this.authorizePage(page, token, check) });
        return this.finishSearch(page, token, check, 'verification-cleared');
      }
      console.log(JSON.stringify({ event: 'nekto_verification_retry', attempt: 1, action: 'return-to-audio-page', widget: 'loaded' }));
      return this.loadAndSearch(page, token, check, setStage);
    })();
    this.entryRetryPromise = retry;
    try { return await retry; }
    finally { if (this.entryRetryPromise === retry) this.entryRetryPromise = null; }
  }
  async next(token, { endCurrentCall = true } = {}) {
    const page = this.page;
    if (!page || page.isClosed()) return this.search(token);
    const generation = this.generation;
    const check = () => {
      if (generation !== this.generation || this.page !== page) throw new Error('Nekto search was stopped.');
    };
    // Let a monitor-owned navigation/confirmation finish before taking control.
    // Stopping its monitor first would cancel the widget wait midway through.
    if (this.entryRetryPromise) await this.entryRetryPromise.catch(() => {});
    if (this.callAdvancePromise) await this.callAdvancePromise.catch(() => {});
    check();
    this.stopSessionMonitor();
    this.forwarding = false;
    this.searchIntent = true;
    try { return await this.advanceSearch(page, token, check, { endCurrentCall }); }
    finally {
      if (generation === this.generation && this.page === page && !page.isClosed()) {
        this.startSessionMonitor(page, token, generation);
      }
    }
  }
  async authorizePage(page, token, check) {
    const identity = await page.evaluate(confirmAudioToken, { token, timeout: 3000 });
    check(); this.authorizationDiagnostics = identity.diagnostics || null;
    if (!identity.ok) throw authorizationError(identity.reason);
  }
  async awaitManualSearch(page, token, check) {
    const state = await this.recordSessionState(page, token, 'manual-search-ready', check);
    check();
    if (state.verification) throw authorizationError('verification-required');
    if (state.restricted) throw authorizationError('native-restriction');
    if (state.attention) throw searchError('attention');
    if (state.searching || state.partnerConnected) return this.finishSearch(page, token, check, 'manual-search-active');
    this.forwarding = false; this.searchIntent = false; this.partnerSeen = false;
    this.waitingForManualSearch = true;
    this.promptInfo = null; this.lastFailure = null; this.controlDiagnostics = null;
    return 'Nekto is ready. Click Search in the bot’s browser window; incoming audio will relay automatically.';
  }
  async advanceSearch(page, token, check, { endCurrentCall = true } = {}) {
    try {
      const state = await advanceAudioCall(page, { check, endCurrentCall, startSearch: !this.manualSearch,
        authorize: () => this.authorizePage(page, token, check) });
      if (this.manualSearch && !state.searching && !state.partnerConnected) return this.awaitManualSearch(page, token, check);
      return await this.finishSearch(page, token, check, endCurrentCall ? 'next-confirmation' : 'resume-confirmation');
    } catch (error) {
      check();
      if (error.code === 'NEKTO_VERIFICATION' && !this.entryRetryUsed && !this.manualSearch) {
        try { return await this.retryFromEntry(page, token, check); }
        catch (retryError) { error = retryError; check(); }
      }
      await this.recordSessionState(page, token, 'next-failure', check).catch(() => {});
      this.controlDiagnostics = await inspectStartControls(page, { token }).catch(() => null);
      check();
      this.promptInfo = this.callState?.attention ? await page.evaluate(readAudioPrompt).catch(() => null) : null;
      const failure = /^NEKTO_/.test(error.code || '') ? error : searchError('next-control');
      this.lastFailure = { code: failure.code, message: failure.message };
      console.warn(JSON.stringify({ event: endCurrentCall ? 'nekto_next_failed' : 'nekto_resume_failed',
        code: failure.code, ...this.callState, ...this.controlDiagnostics }));
      // Preserve failed controls and persistent challenges in the existing page.
      throw failure;
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
    this.waitingForManualSearch = false;
    this.partnerSeen = this.callState.partnerConnected;
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
    return { ...status, manualSearch: this.manualSearch, waitingForManualSearch: this.waitingForManualSearch,
      protocolDiagnostics: this.protocolDiagnostics, forwarding: this.forwarding, authorization: this.authorization || status.authorization, observedStage: this.observedStage, controlDiagnostics: this.controlDiagnostics, lastFailure: this.lastFailure, authorizationDiagnostics: this.authorizationDiagnostics, callState: this.callState, promptInfo: this.promptInfo, microphone: this.microphone };
  }
  async screenshot() {
    const page = this.page;
    if (!page || page.isClosed()) return null;
    return page.screenshot({ type: 'jpeg', quality: 80, fullPage: false });
  }
  async stop() {
    this.stopSessionMonitor();
    this.generation++;
    this.searchIntent = false;
    this.entryRetryUsed = false; this.entryRetryPromise = null;
    this.partnerSeen = false; this.callAdvancePromise = null;
    this.waitingForManualSearch = false;
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
