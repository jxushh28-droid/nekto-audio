import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { installBrowserRelay, inspectBrowserMicrophone } from './browser-init.js';
import { searchError } from './search-error.js';
import { audioClientReady, confirmAudioToken, authorizationError } from './live-session.js';
import { readAudioCallState, waitForAudioSearch } from './call-state.js';
import { readAudioPrompt } from './audio-prompt.js';
import { advanceAudioCall } from './call-controls.js';
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
    this.searchIntent = false;
    this.autoNext = true;
    this.partnerSeen = false; this.callAdvancePromise = null;
    this.manualSearch = process.env.NEKTO_MANUAL_SEARCH === '1';
    this.waitingForManualSearch = false;
    this.authorization = null; this.observedStage = null;
    this.controlDiagnostics = null;
    // Each session has its own non-persistent browser context.
    this.microphonePath = resolve(directory, 'silent-microphone.wav');
    // Outbound proxy (Playwright proxy config) + the public IP the browser is using.
    this.proxy = parseProxy(process.env.NEKTO_PROXY || '');
    this.browserIp = null;
    this.webglRenderer = null;
    this.canvasHash = null;
    this.audioHash = null;
    this.envProbe = null;
  }

  // Set/clear the outbound proxy. Takes a raw string ("socks5://ip:port",
  // "http://user:pass@ip:port", "ip:port", or "" / "off" to clear). Returns a
  // short human description. A live session must be restarted for it to apply.
  setProxy(raw) {
    this.proxy = parseProxy(raw);
    this.browserIp = null;
    return this.proxy ? this.proxy.server : null;
  }

  stopSessionMonitor() {
    this.monitorVersion++;
    clearTimeout(this.monitorTimer);
    this.monitorTimer = null;
  }
  setAutoNext(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Auto-next must be enabled or disabled.');
    this.autoNext = enabled;
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
        if (observed.callState.verification) {
          this.forwarding = false;
          this.searchIntent = false;
          this.partnerSeen = false;
          const failure = authorizationError('verification-required');
          this.lastFailure = { code: failure.code, message: failure.message };
          return;
        }
        if (observed.callState.partnerConnected) this.partnerSeen = true;
        else if (observed.callState.searching && !observed.callState.attention) this.partnerSeen = false;
        const prompt = observed.callState.attention ? await page.evaluate(readAudioPrompt) : null;
        check();
        const callPrompt = prompt?.category === 'call-ended' && !prompt.fieldCount;
        const ended = observed.callState.callEnded;
        if (this.autoNext && this.searchIntent && !observed.callState.verification && !observed.callState.restricted &&
            !observed.callState.searching && !observed.callState.partnerConnected && (callPrompt || ended)) {
          this.forwarding = false;
          const automaticCheck = () => {
            check();
            if (!this.autoNext) throw new Error('Automatic next was disabled.');
          };
          console.log(JSON.stringify({ event: 'nekto_auto_next', reason: callPrompt ? 'call-ended-notice' : 'finished-call-screen', action: 'search-only' }));
          const advance = this.advanceSearch(page, token, automaticCheck, { endCurrentCall: false });
          this.callAdvancePromise = advance;
          try { await advance; }
          catch { if (current()) this.searchIntent = false; } // Fail in place, without repeated prompt clicks.
          finally { if (this.callAdvancePromise === advance) this.callAdvancePromise = null; }
          return;
        }
        if (!observed.callState.searching && !observed.callState.partnerConnected &&
            !observed.callState.verification && !observed.callState.attention) this.searchIntent = false;
        const forwarding = canForwardAudio(observed, captureError);
        if (forwarding) {
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
    this.searchIntent = true;
    this.partnerSeen = false; this.callAdvancePromise = null;
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
      context = await browser.newContext({ viewport: null, ...(this.proxy ? { proxy: this.proxy } : {}) });
      if (this.proxy) console.log(JSON.stringify({ event: 'nekto_proxy_active', server: this.proxy.server }));
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
          // Observe protocol messages without navigating or retrying Start.
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
      // Headless-only: Chrome reports window.screen = 800x600 in headless regardless
      // of --window-size, so the 1920x1080 window ends up LARGER than the screen —
      // physically impossible, and nekto's #1 headless tell (confirmed: headful
      // screen=1920x1080, headless screen=800x600, everything else identical).
      // screen.* are plain value properties (not functions), so overriding them to
      // match the real window does NOT trip nekto's native-code tamper check.
      if (process.env.NEKTO_HEADLESS === '1' || process.env.NEKTO_HEADLESS === 'legacy') {
        const [sw, sh] = (process.env.NEKTO_WINDOW_SIZE || '1920,1080').replace(/x/i, ',').split(',').map(n => parseInt(n, 10) || 0);
        await page.addInitScript(({ w, h }) => {
          try {
            const def = (prop, val) => { try { Object.defineProperty(window.screen, prop, { get: () => val, configurable: true }); } catch (_) {} };
            def('width', w); def('height', h);
            def('availWidth', w); def('availHeight', h - 40);
            def('availLeft', 0); def('availTop', 0);
            try { Object.defineProperty(window, 'devicePixelRatio', { get: () => 1, configurable: true }); } catch (_) {}
          } catch (_) {}
        }, { w: sw || 1920, h: sh || 1080 });
      }
      page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
      return await this.loadAndSearch(page, token, check, value => { stage = value; });
    } catch (error) {
      const cancelled = generation !== this.generation;
      if (!cancelled) {
        this.searchIntent = false; this.partnerSeen = false;
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
    const response = await page.goto(NEKTO_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    check();
    if (response && response.status() >= 400) throw searchError('load');
    // Record the public IP the browser is actually using (through the proxy, if set).
    // Non-fatal: a failed lookup just leaves browserIp null.
    page.evaluate(async () => {
      try {
        const r = await fetch('https://api.ipify.org?format=json', { cache: 'no-store' });
        return (await r.json()).ip || null;
      } catch (_) { return null; }
    }).then(ip => {
      if (ip) { this.browserIp = ip; console.log(JSON.stringify({ event: 'nekto_browser_ip', ip, proxy: this.proxy?.server || null })); }
    }).catch(() => {});
    // Record the WebGL renderer so we can see if headless is falling back to
    // SwiftShader (software) vs the real GPU — the signal nekto uses to spot a VM.
    page.evaluate(() => {
      try {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
        if (!gl) return 'no-webgl';
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
      } catch (_) { return null; }
    }).then(r => {
      if (r) { this.webglRenderer = r; console.log(JSON.stringify({ event: 'nekto_webgl_renderer', renderer: r })); }
    }).catch(() => {});
    // Canvas + audio fingerprint probes — to compare headful vs headless and find
    // which render signal differs (nekto reads both). djb2 hash of the output.
    page.evaluate(async () => {
      const djb2 = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0; return h.toString(16); };
      const out = { canvas: null, audio: null };
      try {
        const c = document.createElement('canvas'); c.width = 280; c.height = 60;
        const ctx = c.getContext('2d');
        ctx.textBaseline = 'top'; ctx.font = "16px 'Arial'";
        ctx.fillStyle = '#f60'; ctx.fillRect(2, 2, 180, 20);
        ctx.fillStyle = '#069'; ctx.fillText('Nekto FP \u{1F600} 12345', 4, 24);
        ctx.fillStyle = 'rgba(102,204,0,0.7)'; ctx.fillText('Nekto FP \u{1F600} 12345', 6, 26);
        out.canvas = djb2(c.toDataURL());
      } catch (_) {}
      try {
        const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        const octx = new Off(1, 44100, 44100);
        const osc = octx.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 10000;
        const comp = octx.createDynamicsCompressor();
        osc.connect(comp); comp.connect(octx.destination); osc.start(0);
        const buf = await octx.startRendering();
        const data = buf.getChannelData(0); let sum = 0;
        for (let i = 4500; i < 5000; i++) sum += Math.abs(data[i]);
        out.audio = sum.toString();
      } catch (_) {}
      return out;
    }).then(fp => {
      if (fp) { this.canvasHash = fp.canvas; this.audioHash = fp.audio;
        console.log(JSON.stringify({ event: 'nekto_render_fp', canvas: fp.canvas, audio: fp.audio })); }
    }).catch(() => {});
    // Non-render environment probes — the remaining headless-vs-headful differences
    // after render FP matched (focus, window dims, webdriver, concurrency).
    page.evaluate(() => {
      try {
        return [
          'wd=' + navigator.webdriver,
          'focus=' + document.hasFocus(),
          'vis=' + document.visibilityState,
          'outer=' + window.outerWidth + 'x' + window.outerHeight,
          'inner=' + window.innerWidth + 'x' + window.innerHeight,
          'screen=' + screen.width + 'x' + screen.height,
          'avail=' + screen.availWidth + 'x' + screen.availHeight,
          'hc=' + navigator.hardwareConcurrency,
          'dm=' + (navigator.deviceMemory || '?'),
        ].join(' ');
      } catch (_) { return null; }
    }).then(env => {
      if (env) { this.envProbe = env; console.log(JSON.stringify({ event: 'nekto_env_probe', env })); }
    }).catch(() => {});
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
    if (this.microphone.permission !== 'granted' || !this.microphone.inputs || !this.microphone.syntheticInputsOnly) throw searchError('microphone');
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
    if (!this.manualSearch && !initial.searching && !initial.partnerConnected) {
      setStage('start-delay');
      await new Promise(resolve => setTimeout(resolve, 1000));
      check();
    }
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
  async next(token, { endCurrentCall = true } = {}) {
    const page = this.page;
    if (!page || page.isClosed()) return this.search(token);
    const generation = this.generation;
    const check = () => {
      if (generation !== this.generation || this.page !== page) throw new Error('Nekto search was stopped.');
    };
    // Let a monitor-owned call confirmation finish before taking control.
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
      // A failed attempt stays in place until an explicit command or native
      // search resumes. The monitor must not press Start a second time.
      this.forwarding = false; this.searchIntent = false; this.partnerSeen = false;
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
    if (!page || page.isClosed()) return { active: false, autoNext: this.autoNext, browserIp: this.browserIp, webglRenderer: this.webglRenderer, canvasHash: this.canvasHash, audioHash: this.audioHash, envProbe: this.envProbe, proxy: this.proxy?.server || null, protocolDiagnostics: this.protocolDiagnostics, authorization: this.authorization, observedStage: this.observedStage, controlDiagnostics: this.controlDiagnostics, lastFailure: this.lastFailure, authorizationDiagnostics: this.authorizationDiagnostics, callState: this.callState, promptInfo: this.promptInfo, microphone: this.microphone };
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
    return { ...status, autoNext: this.autoNext, manualSearch: this.manualSearch, waitingForManualSearch: this.waitingForManualSearch,
      browserIp: this.browserIp, webglRenderer: this.webglRenderer, canvasHash: this.canvasHash, audioHash: this.audioHash, envProbe: this.envProbe, proxy: this.proxy?.server || null,
      protocolDiagnostics: this.protocolDiagnostics, forwarding: this.forwarding, authorization: this.authorization || status.authorization, observedStage: this.observedStage, controlDiagnostics: this.controlDiagnostics, lastFailure: this.lastFailure, authorizationDiagnostics: this.authorizationDiagnostics, callState: this.callState, promptInfo: this.promptInfo, microphone: this.microphone };
  }
  async screenshot() {
    const page = this.page;
    if (!page || page.isClosed()) return null;
    return page.screenshot({ type: 'jpeg', quality: 80, fullPage: false });
  }
  // Forward an input event from the live panel into the page (click to solve a
  // captcha, scroll, type). Coordinates are viewport (CSS) pixels.
  async input(ev) {
    const page = this.page;
    if (!page || page.isClosed()) return false;
    try {
      if (ev.type === 'click') { await page.mouse.click(ev.x, ev.y); return true; }
      if (ev.type === 'dblclick') { await page.mouse.dblclick(ev.x, ev.y); return true; }
      if (ev.type === 'move') { await page.mouse.move(ev.x, ev.y); return true; }
      if (ev.type === 'scroll') { await page.mouse.wheel(0, ev.dy || 0); return true; }
      if (ev.type === 'text') { await page.keyboard.insertText(ev.text || ''); return true; }
      if (ev.type === 'key') { await page.keyboard.press(ev.key || 'Enter'); return true; }
    } catch (_) {}
    return false;
  }
  async stop() {
    this.stopSessionMonitor();
    this.generation++;
    this.searchIntent = false;
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


// Parse a user-supplied proxy string into a Playwright proxy config, or null.
// Accepts: "socks5://ip:port", "http://ip:port", "https://ip:port", "ip:port"
// (defaults to http), each optionally with "user:pass@" credentials. "", "off",
// "none", "clear", "direct" clear the proxy.
export function parseProxy(raw) {
  const s = String(raw || '').trim();
  if (!s || /^(off|none|clear|direct|no)$/i.test(s)) return null;
  let scheme = 'http', rest = s;
  const m = s.match(/^([a-z0-9]+):\/\/(.*)$/i);
  if (m) { scheme = m[1].toLowerCase(); rest = m[2]; }
  if (scheme === 'socks') scheme = 'socks5';
  if (!['http', 'https', 'socks5', 'socks4'].includes(scheme)) return null;
  let username, password;
  const at = rest.lastIndexOf('@');
  if (at !== -1) {
    const creds = rest.slice(0, at); rest = rest.slice(at + 1);
    const ci = creds.indexOf(':');
    if (ci !== -1) { username = creds.slice(0, ci); password = creds.slice(ci + 1); }
    else username = creds;
  }
  if (!/^[^\s:]+:\d{1,5}$/.test(rest)) return null; // require host:port
  const config = { server: `${scheme}://${rest}` };
  // SOCKS proxies in Chromium do not support username/password auth; only attach
  // credentials for http(s) proxies.
  if (username && (scheme === 'http' || scheme === 'https')) { config.username = username; config.password = password || ''; }
  return config;
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
