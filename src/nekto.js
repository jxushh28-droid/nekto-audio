import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
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
import { writeTokenExtension, extensionBrowserOptions, generateFingerprint, fpSeed } from './token-extension.js';
import { waitForStartControl, inspectStartControls } from './start-controls.js';

import { attachNektoDiagnostics, installVerificationObserver, sanitizeVerificationReport } from './network-diagnostics.js';

import { isProfileLockError, recoverRailwayProfileLock } from './profile-lock.js';

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
    this.profilePath = resolve(directory, 'nekto-browser');
    this.extensionPath = resolve(directory, 'nekto-prime');
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
    if (this.context) return this.context;
    await writeTokenExtension(this.extensionPath, token);
    await writeSilentMicrophone(this.microphonePath);
    await mkdir(this.profilePath, { recursive: true, mode: 0o700 });
    // Derive the same deterministic fingerprint used inside the extension script
    // so the Chromium --user-agent flag and the JS navigator spoof always agree.
    const { userAgent } = generateFingerprint(token);
    let context;
    try { context = await chromium.launchPersistentContext(this.profilePath, extensionBrowserOptions(this.extensionPath, this.microphonePath, userAgent)); }
    catch (error) {
      if (!isProfileLockError(error) || !await recoverRailwayProfileLock(this.profilePath)) throw error;
      console.log(JSON.stringify({ event: 'nekto_profile_lock_recovered' }));
      context = await chromium.launchPersistentContext(this.profilePath, extensionBrowserOptions(this.extensionPath, this.microphonePath, userAgent));
    }
    this.context = context; this.browser = context.browser();
    return context;
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
      context = await this.launch(token);
      check();
      await context.grantPermissions(['microphone'], { origin: new URL(NEKTO_URL).origin });
      check();
      this.context = context;
      const page = context.pages()[0] || await context.newPage();
      check();
      this.page = page;
      await attachNektoDiagnostics(page, token, {
        current: () => generation === this.generation && this.page === page,
        onProtocol: report => { this.protocolDiagnostics = updateProtocolSummary(this.protocolDiagnostics, report); },
      });
      await page.exposeBinding('pushNektoAudio', ({ frame }, base64) => {
        if (this.forwarding && generation === this.generation && frame === page.mainFrame() &&
            new URL(frame.url()).origin === new URL(NEKTO_URL).origin) this.onAudio(base64);
      });
      await page.addInitScript(installBrowserRelay, { origin: new URL(NEKTO_URL).origin });
      // Anti-detection: FPT hash bypass + WebGL/Canvas/WebGPU/Client Hints spoof + tab-conflict auto-click.
      // fptHash = md5(token) → stable per-token device identity on nekto's server (prevents ban cross-contamination).
      // fpSeed  = FNV-1a(token) → LCG seed for canvas pixel noise (breaks FingerprintJS cross-slot correlation).
      await page.addInitScript(installAntiDetect, {
        fptHash: createHash('md5').update(token || '').digest('hex'),
        fpSeed: fpSeed(token || ''),
      });
      page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
      stage = 'load';
      const response = await page.goto(NEKTO_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (response && response.status() >= 400) throw searchError('load');
      this.microphone = await page.evaluate(inspectBrowserMicrophone);
      check();
      if (this.microphone.permission !== 'granted' || !this.microphone.inputs) throw searchError('microphone');
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
        if (this.context === context) { this.page = null; this.context = null; this.browser = null; }
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
  async stop() {
    this.stopSessionMonitor();
    this.generation++;
    this.forwarding = false;
    this.protocolDiagnostics = null;
    const context = this.context;
    this.page = null; this.context = null;
    this.browser = null;
    if (context) await context.close().catch(() => {});
  }
  async close() {
    await this.stop();
    await this.browser?.close().catch(() => {});
    this.browser = null;
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
