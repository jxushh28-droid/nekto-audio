import { chromium } from 'playwright';
import { installBrowserRelay } from './browser-init.js';
import { searchError } from './search-error.js';
import { audioClientReady, confirmAudioToken, authorizationError } from './live-session.js';
import { readAudioCallState, waitForAudioSearch } from './call-state.js';
import { readAudioPrompt, respondToAudioPrompt, promptMessage } from './audio-prompt.js';

export const NEKTO_URL = 'https://nekto-me.kz/audiochat#/';

export class NektoBrowser {
  constructor(onAudio) {
    this.onAudio = onAudio; this.page = null; this.browser = null; this.context = null;
    this.generation = 0; this.lastFailure = null; this.authorizationDiagnostics = null; this.callState = null; this.promptInfo = null;
  }
  async launch() {
    if (!this.browser) this.browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--mute-audio'], args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--use-fake-device-for-media-stream',
    ] });
  }
  async search(token) {
    const generation = ++this.generation;
    const previous = this.context;
    this.page = null; this.context = null; this.lastFailure = null; this.authorizationDiagnostics = null; this.callState = null; this.promptInfo = null;
    const check = () => {
      if (generation !== this.generation) throw new Error('Nekto search was stopped.');
    };
    let context;
    let stage = 'setup';
    try {
      if (previous) await previous.close().catch(() => {});
      check();
      await this.launch();
      check();
      context = await this.browser.newContext({ permissions: ['microphone'] });
      check();
      this.context = context;
      const page = await context.newPage();
      check();
      this.page = page;
      await page.exposeBinding('pushNektoAudio', ({ frame }, base64) => {
        if (generation === this.generation && frame === page.mainFrame() &&
            new URL(frame.url()).origin === new URL(NEKTO_URL).origin) this.onAudio(base64);
      });
      await page.addInitScript(installBrowserRelay, { token, origin: new URL(NEKTO_URL).origin });
      page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
      stage = 'load';
      const response = await page.goto(NEKTO_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (response && response.status() >= 400) throw searchError('load');
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
      check();
      await page.evaluate(reason => { window.__nektoRelay.authorization = reason; }, authorization.reason);
      const initial = await page.evaluate(readAudioCallState);
      if (initial.attention || initial.verification || initial.restricted) return await this.finishSearch(page, token, check);
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
      return await this.finishSearch(page, token, check);
    } catch (error) {
      const cancelled = generation !== this.generation;
      if (!cancelled) await this.stop();
      else await context?.close().catch(() => {});
      if (cancelled) throw new Error('Nekto search was stopped.');
      const known = ['Nekto is asking for browser verification. Automatic search stopped.',
        'Audio capture initialization failed.', 'Remote audio capture failed.'];
      const failure = known.includes(error.message) || /^NEKTO_(VUEX_|AUTH_|TOKEN_|VERIFICATION$|REGISTRATION$|RESTRICTED$|ATTENTION$|SEARCH_)/.test(error.code || '')
        ? error : searchError(stage);
      this.lastFailure = { code: failure.code || 'NEKTO_CAPTURE_OR_VERIFICATION', message: failure.message };
      throw failure;
    }
  }
  async finishSearch(page, token, check) {
    for (let attempt = 0; attempt < 3; attempt++) {
      this.callState = await waitForAudioSearch(page, { check });
      if (this.callState.verification) throw authorizationError('verification-required');
      if (this.callState.restricted) throw authorizationError('native-restriction');
      if (this.callState.attention) {
        const result = await respondToAudioPrompt(page, { automatic: true });
        check();
        this.promptInfo = result.prompt;
        if (!result.handled) {
          this.lastFailure = { code: 'NEKTO_ATTENTION', message: 'Nekto needs a response to its visible prompt. Use /prompt to inspect it and /answer to respond.' };
          return `${promptMessage(result.prompt, token)} Use /prompt to view it; /answer value:<your response> to answer a setting, or /answer for a normal confirmation.`;
        }
        await page.waitForTimeout(250);
        check();
        const state = await page.evaluate(readAudioCallState);
        if (state.phase === 'ready to search') await page.locator('#searchCompanyBtn').click({ timeout: 3000 });
        continue;
      }
      check();
      const confirmedIdentity = await page.evaluate(confirmAudioToken, { token, timeout: 3000 });
      check();
      this.authorizationDiagnostics = confirmedIdentity.diagnostics || null;
      if (!confirmedIdentity.ok) throw authorizationError(confirmedIdentity.reason);
      this.promptInfo = null; this.lastFailure = null;
      return 'Searching on Nekto. Incoming audio will play here when someone connects.';
    }
    throw searchError('attention');
  }
  async promptDetails(token) {
    if (!this.page || this.page.isClosed()) return { content: 'Nekto is stopped. Use /join to open it.' };
    const prompt = await this.page.evaluate(readAudioPrompt);
    if (!prompt.visible) return { content: 'Nekto has no visible website prompt.' };
    const image = await this.page.locator('.swal2-popup').filter({ visible: true }).screenshot({ timeout: 3000 }).catch(() => null);
    return { content: promptMessage(prompt, token), files: image ? [{ attachment: image, name: 'nekto-prompt.png' }] : [], allowedMentions: { parse: [] } };
  }
  async answerPrompt(token, value) {
    const page = this.page, generation = this.generation;
    const check = () => { if (generation !== this.generation || !page || page.isClosed()) throw new Error('Nekto search was stopped.'); };
    check();
    const identity = await page.evaluate(confirmAudioToken, { token, timeout: 3000 });
    check();
    if (!identity.ok) throw authorizationError(identity.reason);
    const result = await respondToAudioPrompt(page, { value });
    check();
    this.promptInfo = result.prompt;
    if (!result.handled) return `${promptMessage(result.prompt, token)} This prompt remains open. Provide its setting with /answer value:<response>, or inspect it with /prompt.`;
    await page.waitForTimeout(250);
    check();
    const state = await page.evaluate(readAudioCallState);
    if (state.phase === 'ready to search') await page.locator('#searchCompanyBtn').click({ timeout: 3000 });
    return this.finishSearch(page, token, check);
  }
  async status() {
    const page = this.page;
    if (!page || page.isClosed()) return { active: false, lastFailure: this.lastFailure, authorizationDiagnostics: this.authorizationDiagnostics, callState: this.callState, promptInfo: this.promptInfo };
    this.callState = await page.evaluate(readAudioCallState);
    this.promptInfo = this.callState.attention ? await page.evaluate(readAudioPrompt) : null;
    const status = await page.evaluate(() => ({ active: true, ...window.__nektoRelay }));
    return { ...status, lastFailure: this.lastFailure, authorizationDiagnostics: this.authorizationDiagnostics, callState: this.callState, promptInfo: this.promptInfo };
  }
  async stop() {
    this.generation++;
    const context = this.context;
    this.page = null; this.context = null;
    if (context) await context.close().catch(() => {});
  }
  async close() {
    await this.stop();
    await this.browser?.close().catch(() => {});
    this.browser = null;
  }
}

