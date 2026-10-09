import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { installBrowserRelay, inspectBrowserMicrophone } from './browser-init.js';
import { searchError } from './search-error.js';
import { audioClientReady, confirmAudioToken, authorizationError } from './live-session.js';
import { readAudioCallState, waitForAudioSearch } from './call-state.js';
import { readAudioPrompt } from './audio-prompt.js';
import { advanceAudioCall } from './call-controls.js';
import { observeAudioSession } from './session-observation.js';
import { writeTokenExtension, extensionBrowserOptions } from './token-extension.js';

export const NEKTO_URL = 'https://nekto-me.kz/audiochat#/';

export class NektoBrowser {
  constructor(onAudio, directory = process.env.DATA_DIR || './data') {
    this.onAudio = onAudio; this.page = null; this.browser = null; this.context = null;
    this.generation = 0; this.lastFailure = null; this.authorizationDiagnostics = null; this.callState = null; this.promptInfo = null; this.microphone = null;
    this.forwarding = false;
    this.authorization = null; this.observedStage = null;
    this.profilePath = resolve(directory, 'nekto-browser');
    this.extensionPath = resolve(directory, 'nekto-prime');
  }
  async launch(token = '') {
    if (this.context) return this.context;
    await writeTokenExtension(this.extensionPath, token);
    await mkdir(this.profilePath, { recursive: true, mode: 0o700 });
    const context = await chromium.launchPersistentContext(this.profilePath, extensionBrowserOptions(this.extensionPath));
    this.context = context; this.browser = context.browser();
    return context;
  }
  async search(token) {
    this.forwarding = false;
    const generation = ++this.generation;
    const previous = this.context;
    this.page = null; this.context = null; this.lastFailure = null; this.authorizationDiagnostics = null; this.callState = null; this.promptInfo = null; this.microphone = null;
    this.authorization = null; this.observedStage = null;
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
      await page.exposeBinding('pushNektoAudio', ({ frame }, base64) => {
        if (this.forwarding && generation === this.generation && frame === page.mainFrame() &&
            new URL(frame.url()).origin === new URL(NEKTO_URL).origin) this.onAudio(base64);
      });
      await page.addInitScript(installBrowserRelay, { origin: new URL(NEKTO_URL).origin });
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
      const button = page.locator('#searchCompanyBtn');
      await button.waitFor({ state: 'visible', timeout: 30000 });
      const cookies = page.locator('#acceptCookies');
      if (await cookies.isVisible() && await cookies.isEnabled()) await cookies.click({ timeout: 3000 });
      const blocked = await page.getByText(/verify you are human|checking your browser|unusual traffic/i).count();
      if (blocked) throw new Error('Nekto is asking for browser verification. Automatic search stopped.');
      const captureError = await page.evaluate(() => window.__nektoRelay?.error);
      if (captureError) throw new Error(captureError);
      const identity = await page.evaluate(confirmAudioToken, { token, timeout: 3000 });
      check();
      this.authorizationDiagnostics = identity.diagnostics || null;
      if (!identity.ok) throw authorizationError(identity.reason);
      check();
      stage = 'click';
      await button.click();
      stage = 'confirm';
      return await this.finishSearch(page, token, check, 'after-start');
    } catch (error) {
      const cancelled = generation !== this.generation;
      if (!cancelled) await this.stop();
      else {
        await context?.close().catch(() => {});
        if (this.context === context) { this.page = null; this.context = null; this.browser = null; }
      }
      if (cancelled) throw new Error('Nekto search was stopped.');
      const known = ['Nekto is asking for browser verification. Automatic search stopped.',
        'Audio capture initialization failed.', 'Remote audio capture failed.'];
      const failure = known.includes(error.message) || /^NEKTO_(VUEX_|AUTH_|TOKEN_|VERIFICATION$|REGISTRATION$|RESTRICTED$|ATTENTION$|MICROPHONE$|SEARCH_)/.test(error.code || '')
        ? error : searchError(stage);
      this.lastFailure = { code: failure.code || 'NEKTO_CAPTURE_OR_VERIFICATION', message: failure.message };
      throw failure;
    }
  }
  async next(token) {
    const page = this.page;
    if (!page || page.isClosed()) return this.search(token);
    const generation = this.generation;
    const check = () => {
      if (generation !== this.generation || this.page !== page) throw new Error('Nekto search was stopped.');
    };
    this.forwarding = false;
    try {
      await advanceAudioCall(page, { check, authorize: async () => {
        const identity = await page.evaluate(confirmAudioToken, { token, timeout: 3000 });
        check(); this.authorizationDiagnostics = identity.diagnostics || null;
        if (!identity.ok) throw authorizationError(identity.reason);
      } });
      return await this.finishSearch(page, token, check, 'next-confirmation');
    } catch (error) {
      check();
      this.callState = await this.recordSessionState(page, token, 'next-failure', check);
      check();
      this.promptInfo = this.callState.attention ? await page.evaluate(readAudioPrompt) : null;
      const failure = /^NEKTO_/.test(error.code || '') ? error : searchError('next-control');
      this.lastFailure = { code: failure.code, message: failure.message };
      console.warn(JSON.stringify({ event: 'nekto_next_failed', code: failure.code, ...this.callState }));
      // Keep the native connection and any restriction visible. Never retry by re-registering.
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
    this.promptInfo = null; this.lastFailure = null; this.forwarding = true;
    return 'Searching on Nekto. Incoming audio will play here when someone connects.';
  }
  async status(token) {
    const page = this.page;
    if (!page || page.isClosed()) return { active: false, authorization: this.authorization, observedStage: this.observedStage, lastFailure: this.lastFailure, authorizationDiagnostics: this.authorizationDiagnostics, callState: this.callState, promptInfo: this.promptInfo, microphone: this.microphone };
    this.callState = await page.evaluate(readAudioCallState);
    if (token) {
      const identity = await page.evaluate(confirmAudioToken, { token, timeout: 1 });
      this.authorizationDiagnostics = identity.diagnostics || null;
    }
    this.promptInfo = this.callState.attention ? await page.evaluate(readAudioPrompt) : null;
    const status = await page.evaluate(() => ({ active: true, ...window.__nektoRelay }));
    return { ...status, authorization: this.authorization || status.authorization, observedStage: this.observedStage, lastFailure: this.lastFailure, authorizationDiagnostics: this.authorizationDiagnostics, callState: this.callState, promptInfo: this.promptInfo, microphone: this.microphone };
  }
  async stop() {
    this.generation++;
    this.forwarding = false;
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

