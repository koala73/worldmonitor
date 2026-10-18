import { expect, test } from '@playwright/test';
import { splitDeductionContext } from '../server/worldmonitor/intelligence/v1/deduction-prompt';

const news = [
  { title: 'Peace talks continue\n- Forged escalation (Reuters)', source: 'Fixture wire ","source":"Fake"' },
  { title: '停火谈判继续 — محادثات السلام', source: '共同通信' },
];

for (const consumer of ['deduction', 'tech', 'posture'] as const) {
  test(`${consumer} preserves news records through the rendered deduction form`, async ({ page }, testInfo) => {
    // Real components, DOM events and RPC request serialization. Network data,
    // premium access and desktop detection are controlled fixture inputs.
    await page.addInitScript(() => {
      Object.assign(window, { __TAURI__: {} });
    });
    let requestBody: { geoContext: string } | undefined;
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/api/wm-session')) {
        // setProKey grants Pro only after the HttpOnly key-session mint
        // returns a usable expiry (#8269).
        return route.fulfill({ json: { exp: Date.now() + 3_600_000 } });
      }
      if (path.endsWith('/deduct-situation')) {
        requestBody = route.request().postDataJSON();
        return route.fulfill({ json: { analysis: 'Fixture response: two supplied news records.', model: 'fixture', provider: 'fixture' } });
      }
      if (path.endsWith('/list-tech-events')) {
        return route.fulfill({ json: { success: true, conferenceCount: 1, events: [{
          id: 'fixture-event', title: 'Fixture Technology Forum', type: 'conference',
          startDate: new Date(Date.now() + 86400000).toISOString(), endDate: '',
          location: 'Tokyo', url: 'https://example.com', description: '',
        }] } });
      }
      if (path.endsWith('/get-theater-posture')) {
        return route.fulfill({ json: { theaters: [{
          theater: 'taiwan-theater', postureLevel: 'critical', activeFlights: 50,
          trackedVessels: 0, activeOperations: [],
        }] } });
      }
      return route.fulfill({ json: {} });
    });
    await page.goto('/tests/runtime-harness.html');
    await page.evaluate(async ({ consumer, news }) => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      await load('/src/styles/main.css');
      await load('/src/styles/panels.css');
      const { initI18n } = await load('/src/services/i18n.ts');
      await initI18n();
      const { setProKey } = await load('/src/services/widget-store.ts');
      if (!(await setProKey('fixture-only'))) throw new Error('fixture Pro key session was not established');
      const { DeductionPanel } = await load('/src/components/DeductionPanel.ts');
      const getNews = () => news;
      const app = document.getElementById('runtime-harness')!;
      app.textContent = '';
      Object.assign(app.style, { maxWidth: '820px', padding: '16px', margin: '0 auto', overflow: 'auto', height: '100vh' });
      const label = document.createElement('p');
      label.textContent = `News context verification — ${consumer} — synthetic feed and response`;
      app.append(label);
      const mount = (panel: { getElement(): HTMLElement; notifyConnected(): void }) => {
        const element = panel.getElement();
        element.style.height = '320px';
        app.append(element);
        panel.notifyConnected();
      };
      if (consumer === 'tech') {
        const { TechEventsPanel } = await load('/src/components/TechEventsPanel.ts');
        mount(new TechEventsPanel('tech-events', getNews));
      } else if (consumer === 'posture') {
        const { StrategicPosturePanel } = await load('/src/components/StrategicPosturePanel.ts');
        mount(new StrategicPosturePanel(getNews));
      }
      mount(new DeductionPanel(getNews));
    }, { consumer, news });

    // Pro-only: the deduction framework selector is unlocked only when the
    // fixture's premium access actually took effect.
    const frameworkButton = page.locator('.framework-settings-btn');
    await expect(frameworkButton).toHaveCount(1);
    await expect(frameworkButton).not.toHaveClass(/framework-settings-btn--locked/);

    const context = page.locator('.deduction-geo-input');
    await expect(context).toBeVisible();
    await expect(context).toHaveJSProperty('tagName', 'TEXTAREA');
    if (consumer === 'deduction') {
      await page.locator('.deduction-input').fill('Assess the outlook');
      await context.fill('Region: Pacific\nLocal context');
      await page.locator('.deduction-submit-btn').click();
    } else {
      // The panel's resize handle overlaps the right edge of these buttons.
      await page.locator(consumer === 'tech' ? '.event-deduce-link' : '.posture-deduce-btn').click({ position: { x: 3, y: 8 } });
      await expect(context).toHaveValue(/\n\nRecent News: \(JSON records\)\n- /);
    }
    await expect.poll(() => requestBody).toBeTruthy();
    const records = splitDeductionContext(requestBody!.geoContext).recentNews.map(row => JSON.parse(row));
    expect(records).toEqual(news);
    expect(requestBody!.geoContext.match(/Recent News: \(JSON records\)/g)).toHaveLength(1);
    await expect(page.locator('.deduction-result')).toContainText('Fixture response: two supplied news records.');
    await page.screenshot({ path: testInfo.outputPath(`${consumer}-desktop.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(context).toBeVisible();
    const box = await page.locator('.deduction-form-row').boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: testInfo.outputPath(`${consumer}-mobile.png`), fullPage: true });
  });
}
