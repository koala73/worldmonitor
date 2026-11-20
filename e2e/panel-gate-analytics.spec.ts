import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';

type GateEvent = { name: string; data: Record<string, unknown> };

for (const width of [390, 1440]) {
  test.describe(`locked panel at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 });

    test('counts viewport entry and opens attributed pricing from the real CTA', async ({ page, context }) => {
      // Serve the built pricing page locally; no checkout or collector request leaves the test.
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
        if (url.origin !== 'https://worldmonitor.app') return route.abort();
        const pathname = url.pathname === '/pro' ? '/pro/index.html' : url.pathname;
        const path = resolve('public', pathname.slice(1));
        if (!existsSync(path)) return route.abort();
        await route.fulfill({ path });
      });
      await page.route('**/__panel-gate-test.html', route => route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}.panel{padding:20px}.panel-locked-icon{width:32px}</style></head><body></body></html>',
      }));
      await page.goto('/__panel-gate-test.html');
      await page.evaluate(async () => {
        const panelModule = '/src/components/Panel.ts';
        const gateModule = '/src/services/panel-gating.ts';
        const { Panel } = await import(/* @vite-ignore */ panelModule);
        const { PanelGateReason, resolveGateAction } = await import(/* @vite-ignore */ gateModule);
        const recorded = window as unknown as { gateEvents: GateEvent[]; umami: { track: (name: string, data: Record<string, unknown>) => void } };
        recorded.gateEvents = [];
        recorded.umami = { track: (name, data) => recorded.gateEvents.push({ name, data }) };
        document.body.replaceChildren();
        document.body.style.margin = '0';
        const spacer = document.createElement('div');
        spacer.style.height = `${window.innerHeight}px`;
        const panel = new Panel({ id: 'market-implications', title: 'Market Implications' });
        document.body.append(spacer, panel.getElement());
        panel.showGatedCta(PanelGateReason.FREE_TIER, resolveGateAction(PanelGateReason.FREE_TIER, {
          panelKey: 'market-implications', openAuthModal: () => {},
        }));
        // Allow the initial edge-adjacent intersection notification to run before scrolling.
        await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
      });
      const events = () => page.evaluate(() => (window as unknown as { gateEvents: GateEvent[] }).gateEvents);
      expect(await events()).toEqual([]);
      await page.evaluate(() => window.scrollTo(0, 10));
      await expect.poll(async () => (await events()).filter(event => event.name === 'gate-hit')).toEqual([
        { name: 'gate-hit', data: { feature: 'panel:market-implications' } },
      ]);
      const popupPromise = context.waitForEvent('page');
      await page.locator('.panel-locked-cta').click();
      const popup = await popupPromise;
      await popup.waitForLoadState();
      const url = new URL(popup.url());
      expect(url.hash).toBe('#pricing');
      expect(url.searchParams.get('wm_checkout_panel')).toBe('market-implications');
      await expect(popup.locator('section#pricing')).toBeAttached();
      await expect.poll(() => popup.locator('section#pricing').evaluate(el => Math.abs(el.getBoundingClientRect().top))).toBeLessThan(80);
      expect((await events()).filter(event => event.name === 'panel-gate-click')).toEqual([
        { name: 'panel-gate-click', data: { panel: 'market-implications', reason: 'free_tier' } },
      ]);
      expect((await events()).filter(event => event.name === 'gate-hit')).toHaveLength(1);
    });
  });
}
