import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    __orefState: { released: number; active: number };
    __orefFixture: {
      panelUpdates: number;
      cacheUpdates: number;
      fetches: number;
      refresh: () => Promise<void>;
      destroy: () => void;
      beginPending: () => void;
      finishPending: () => Promise<void>;
      releaseTranslation: (() => void) | null;
      releaseFetch: (() => void) | null;
    };
  }
}


test('OREF subscriptions can be released independently and global stop cancels polling', async ({ page }) => {
  await page.goto('/tests/runtime-harness.html');
  await page.clock.install();
  const hasUnsubscribe = await page.evaluate(async () => {
    const oref = await import('/src/services/oref-alerts.ts');
    const state = { released: 0, active: 0 };
    window.__orefState = state;
    window.fetch = async () => new Response(JSON.stringify({ configured: true, alerts: [], historyCount24h: 3, timestamp: new Date().toISOString() }));
    const unsubscribe = oref.onOrefAlertsUpdate(() => state.released++);
    oref.onOrefAlertsUpdate(() => state.active++);
    if (typeof unsubscribe !== 'function') return false;
    unsubscribe();
    unsubscribe();
    oref.startOrefPolling();
    return true;
  });
  expect(hasUnsubscribe).toBe(true);
  await page.clock.runFor(133_000);
  await expect.poll(() => page.evaluate(() => window.__orefState)).toEqual({ released: 0, active: 1 });
  await page.evaluate(async () => (await import('/src/services/oref-alerts.ts')).stopOrefPolling());
  await page.clock.runFor(266_000);
  expect(await page.evaluate(() => window.__orefState)).toEqual({ released: 0, active: 1 });
});

test('loader refreshes retain one poll and translation subscriber and reject late teardown results', async ({ page }, testInfo) => {
  await page.goto('/tests/runtime-harness.html');
  await page.clock.install();
  await page.evaluate(async () => {
    await import('/src/styles/main.css');
    const { initI18n } = await import('/src/services/i18n.ts');
    await initI18n();
    const [{ DataLoaderManager }, { OrefSirensPanel }, { _setTestProviders }] = await Promise.all([
      import('/src/app/data-loader.ts'), import('/src/components/OrefSirensPanel.ts'), import('/src/services/premium-fetch.ts'),
    ]);
    _setTestProviders({ getTesterKey: () => 'fixture', getClerkToken: async () => null });
    const panel = new OrefSirensPanel();
    const fixture: Window['__orefFixture'] = window.__orefFixture = {
      panelUpdates: 0, cacheUpdates: 0, fetches: 0,
      refresh: async () => {}, destroy: () => {}, beginPending: () => {}, finishPending: async () => {},
      releaseTranslation: null, releaseFetch: null,
    };
    let holdNext = false;
    let pending: Promise<void> | null = null;
    const data = {
      configured: true, historyCount24h: 3, timestamp: new Date().toISOString(),
      alerts: [{ id: 'test-alert', cat: '1', title: 'בדיקה מיוחדת', data: ['Tel Aviv'], desc: '', alertDate: new Date().toISOString() }],
    };
    window.fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
      if (url.pathname.endsWith('/summarize-article')) {
        return new Promise<Response>(resolve => {
          fixture.releaseTranslation = () => resolve(new Response(JSON.stringify({
            summary: 'ALERT[test-alert]: Translated test alert\nAREAS[test-alert]: Tel Aviv\nDESC[test-alert]: Stay safe',
            fallback: false, status: 'SUMMARIZE_STATUS_SUCCESS',
          })));
        });
      }
      if (url.searchParams.get('endpoint') === 'history') return new Response(JSON.stringify({ configured: true, history: [], historyCount24h: 3 }));
      if (url.pathname === '/api/oref-alerts') {
        fixture.fetches++;
        if (holdNext) {
          holdNext = false;
          return new Promise<Response>(resolve => { fixture.releaseFetch = () => resolve(new Response(JSON.stringify(data))); });
        }
        return new Response(JSON.stringify(data));
      }
      return new Response('{}');
    };
    const setData = panel.setData.bind(panel);
    panel.setData = value => { fixture.panelUpdates++; setData(value); };
    const intelligenceCache = {};
    Object.defineProperty(intelligenceCache, 'orefAlerts', { set: () => { fixture.cacheUpdates++; } });
    const loader = new DataLoaderManager({ panels: { 'oref-sirens': panel }, intelligenceCache } as never, {
      renderCriticalBanner() {}, refreshOpenCountryBrief() {},
    });
    fixture.refresh = () => loader.loadOrefAlerts();
    fixture.destroy = () => loader.destroy();
    fixture.beginPending = () => { holdNext = true; pending = loader.loadOrefAlerts(); };
    fixture.finishPending = async () => { fixture.releaseFetch?.(); await pending; };
    document.body.replaceChildren();
    const heading = document.createElement('h1');
    heading.textContent = 'Controlled OREF lifecycle fixture';
    const button = document.createElement('button');
    button.textContent = 'Refresh OREF ten times';
    button.onclick = async () => {
      for (let i = 0; i < 10; i++) await fixture.refresh();
    };
    panel.getElement().style.cssText = 'width:700px;height:500px;margin:16px;';
    document.body.append(heading, button, panel.getElement());
  });
  await page.getByRole('button', { name: 'Refresh OREF ten times', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__orefFixture.panelUpdates)).toBe(10);
  await expect.poll(() => page.evaluate(() => typeof window.__orefFixture.releaseTranslation)).toBe('function');
  await page.evaluate(() => window.__orefFixture.releaseTranslation!());
  await expect.poll(() => page.evaluate(() => window.__orefFixture.panelUpdates)).toBe(11);
  await expect(page.locator('.oref-alert-title')).toHaveText('Translated test alert');
  await page.clock.runFor(133_000);
  await expect.poll(() => page.evaluate(() => ({ panel: window.__orefFixture.panelUpdates, cache: window.__orefFixture.cacheUpdates }))).toEqual({ panel: 12, cache: 12 });
  await page.screenshot({ path: testInfo.outputPath('oref-single-subscription.png'), fullPage: true, animations: 'disabled' });

  await page.clock.runFor(9_000);
  await page.evaluate(() => window.__orefFixture.beginPending());
  await expect.poll(() => page.evaluate(() => typeof window.__orefFixture.releaseFetch)).toBe('function');
  const before = await page.evaluate(() => ({ panel: window.__orefFixture.panelUpdates, cache: window.__orefFixture.cacheUpdates, fetches: window.__orefFixture.fetches }));
  await page.evaluate(async () => {
    window.__orefFixture.destroy();
    await window.__orefFixture.finishPending();
    await window.__orefFixture.refresh();
  });
  await page.clock.runFor(266_000);
  expect(await page.evaluate(() => ({ panel: window.__orefFixture.panelUpdates, cache: window.__orefFixture.cacheUpdates, fetches: window.__orefFixture.fetches }))).toEqual(before);
});
