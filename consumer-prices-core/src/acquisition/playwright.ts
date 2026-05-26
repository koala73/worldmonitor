import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { AcquisitionProvider, FetchOptions, FetchResult, SearchOptions, SearchResult } from './types.js';

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export class PlaywrightProvider implements AcquisitionProvider {
  readonly name = 'playwright' as const;

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  private async getContext(): Promise<BrowserContext> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
    }
    if (!this.context) {
      this.context = await this.browser.newContext({
        userAgent: DEFAULT_UA,
        locale: 'en-US',
        viewport: { width: 1280, height: 900 },
        extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
      });
    }
    return this.context;
  }

  async fetch(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
    const ctx = await this.getContext();
    const page = await ctx.newPage();

    const timeout = opts.timeout ?? 30_000;

    try {
      if (opts.headers) {
        await page.setExtraHTTPHeaders(opts.headers);
      }

      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

      if (opts.waitForSelector) {
        await page.waitForSelector(opts.waitForSelector, { timeout: 10_000 }).catch(() => {});
      }

      const html = await page.content();
      const statusCode = response?.status() ?? 200;

      return { url, html, statusCode, provider: this.name, fetchedAt: new Date() };
    } finally {
      await page.close();
    }
  }

  async search(_query: string, _opts?: SearchOptions): Promise<SearchResult[]> {
    throw new Error('PlaywrightProvider does not support search mode. Use Exa instead.');
  }

  async validate(): Promise<boolean> {
    try {
      await this.getContext();
      return true;
    } catch {
      return false;
    }
  }

  async teardown(): Promise<void> {
    const timeout = new Promise<void>(r => setTimeout(r, 5000));
    await Promise.race([
      Promise.allSettled([this.context?.close(), this.browser?.close()]),
      timeout,
    ]);
    this.context = null;
    this.browser = null;
  }
}
