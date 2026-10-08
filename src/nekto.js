import { chromium } from 'playwright';
import { installBrowserRelay } from './browser-init.js';
import { searchError } from './search-error.js';

export const NEKTO_URL = 'https://nekto-me.kz/audiochat#/';
const START = /^(Начать разговор|Начать поиск|Start conversation|Start search|Әңгімелесуді бастау)$/i;

export class NektoBrowser {
  constructor(onAudio) {
    this.onAudio = onAudio; this.page = null; this.browser = null; this.context = null;
    this.generation = 0; this.lastFailure = null;
  }
  async launch() {
    if (!this.browser) this.browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--mute-audio'], args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    ] });
  }
  async search(token) {
    const generation = ++this.generation;
    const previous = this.context;
    this.page = null; this.context = null; this.lastFailure = null;
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
      stage = 'control';
      const button = page.getByRole('button', { name: START }).first();
      await button.waitFor({ state: 'visible', timeout: 30000 });
      const blocked = await page.getByText(/verify you are human|checking your browser|unusual traffic/i).count();
      if (blocked) throw new Error('Nekto is asking for browser verification. Automatic search stopped.');
      const captureError = await page.evaluate(() => window.__nektoRelay?.error);
      if (captureError) throw new Error(captureError);
      check();
      stage = 'click';
      await button.click();
      stage = 'confirm';
      await page.waitForFunction(() => {
        const start = [...document.querySelectorAll('button')].find(b =>
          /^(Начать разговор|Начать поиск|Start conversation|Start search|Әңгімелесуді бастау)$/i.test(b.textContent.trim()));
        return window.__nektoRelay?.tracks > 0 || !start || start.disabled || start.offsetParent === null;
      }, null, { timeout: 15000 });
      check();
      return 'Searching on Nekto. Incoming audio will play here when someone connects.';
    } catch (error) {
      const cancelled = generation !== this.generation;
      if (!cancelled) await this.stop();
      else await context?.close().catch(() => {});
      if (cancelled) throw new Error('Nekto search was stopped.');
      const known = ['Nekto is asking for browser verification. Automatic search stopped.',
        'Audio capture initialization failed.', 'Remote audio capture failed.'];
      const failure = known.includes(error.message) ? error : searchError(stage);
      this.lastFailure = { code: failure.code || 'NEKTO_CAPTURE_OR_VERIFICATION', message: failure.message };
      throw failure;
    }
  }
  async status() {
    const page = this.page;
    if (!page || page.isClosed()) return { active: false, lastFailure: this.lastFailure };
    const status = await page.evaluate(() => ({ active: true, ...window.__nektoRelay }));
    return { ...status, lastFailure: this.lastFailure };
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
