import { chromium } from 'playwright';
import { installBrowserRelay } from './browser-init.js';

export const NEKTO_URL = 'https://nekto-me.kz/audiochat';
const START = /^(Начать разговор|Начать поиск|Start conversation|Start search|Әңгімелесуді бастау)$/i;

export class NektoBrowser {
  constructor(onAudio) { this.onAudio = onAudio; this.page = null; this.browser = null; this.context = null; }
  async launch() {
    if (!this.browser) this.browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--mute-audio'], args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    ] });
  }
  async search(token) {
    await this.stop();
    await this.launch();
    try {
      this.context = await this.browser.newContext({ permissions: ['microphone'] });
      this.page = await this.context.newPage();
      await this.page.exposeBinding('pushNektoAudio', ({ frame }, base64) => {
        if (frame === this.page?.mainFrame() && frame.url().startsWith('https://nekto-me.kz/')) this.onAudio(base64);
      });
      await this.page.addInitScript(installBrowserRelay, { token, origin: new URL(NEKTO_URL).origin });
      this.page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
      await this.page.goto(NEKTO_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const button = this.page.getByRole('button', { name: START }).first();
      await button.waitFor({ state: 'visible', timeout: 30000 });
      // No automatic retries or anti-bot workarounds.
      const blocked = await this.page.getByText(/verify you are human|checking your browser|unusual traffic/i).count();
      if (blocked) throw new Error('Nekto is asking for browser verification. Automatic search stopped.');
      const captureError = await this.page.evaluate(() => window.__nektoRelay?.error);
      if (captureError) throw new Error(captureError);
      await button.click();
      // A disappearing/disabled start button or a live track confirms the click changed state.
      await this.page.waitForFunction(() => {
        const start = [...document.querySelectorAll('button')].find(b => /^(Начать разговор|Начать поиск|Start conversation|Start search|Әңгімелесуді бастау)$/i.test(b.textContent.trim()));
        return window.__nektoRelay?.tracks > 0 || !start || start.disabled || start.offsetParent === null;
      }, null, { timeout: 15000 });
      return 'Searching on Nekto. Incoming audio will play here when someone connects.';
    } catch (error) {
      await this.stop();
      if (error.message.startsWith('Nekto is asking') || error.message.includes('capture')) throw error;
      throw new Error('Nekto search could not be started. Check your token and try /join again; the site may need browser verification or have changed its controls.');
    }
  }
  async status() {
    if (!this.page || this.page.isClosed()) return { active: false };
    return this.page.evaluate(() => ({ active: true, ...window.__nektoRelay }));
  }
  async stop() {
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
