import { expect, test } from '@playwright/test';

// Real panel renderers and shared CSS, with deterministic RPC fixtures. This
// isolates list scrolling from provider availability and the dashboard's map.
for (const width of [1440, 390]) {
  test(`ordinary panel lists share the panel scrollport at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 900 });
    const now = Date.now();
    const rows = Array.from({ length: 40 }, (_, i) => i);
    await page.route('**/api/**', route => route.fulfill({ json: {} }));
    await page.route(/list-climate-news/, route => route.fulfill({ json: {
      items: rows.map(i => ({ id: `news-${i}`, title: `Climate headline ${i}`, summary: 'Fixture climate reporting for scrolling verification.', url: `https://example.test/${i}`, sourceName: 'Test source', publishedAt: now - i * 60_000 })),
      dataAvailable: true, fetchedAt: now,
    } }));
    await page.route(/list-earnings-calendar/, route => route.fulfill({ json: {
      earnings: rows.map(i => ({ symbol: `SYM${i}`, company: `Company ${i}`, date: '2026-11-05', hour: 'bmo', epsEstimate: 1, revenueEstimate: 1000, epsActual: 0, revenueActual: 0, hasActuals: false, surpriseDirection: '' })),
    } }));
    await page.route(/get-economic-calendar/, route => route.fulfill({ json: {
      events: rows.map(i => ({ event: `Economic event ${i}`, country: 'US', date: new Date(now + i * 60_000).toISOString(), impact: 'High', actual: '', estimate: '1', previous: '2', unit: '%' })),
    } }));
    await page.route(/list-material-events/, route => route.fulfill({ json: {
      events: rows.map(i => ({ company: `Filer ${i}`, cik: `${i}`, form: '8-K', filedAtMs: now - i * 60_000, items: [{ code: '2.02', description: 'Results' }], url: `https://www.sec.gov/Archives/${i}` })),
    } }));
    await page.goto('/tests/runtime-harness.html');
    const ids = await page.evaluate(async () => {
      await import('/src/styles/main.css');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      document.getElementById('runtime-harness')?.remove();
      const grid = document.createElement('main');
      grid.id = 'panelsGrid';
      grid.className = 'panels-grid';
      // The fixture uses real panel shells at a desktop/sidebar or phone width.
      grid.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr);grid-auto-rows:auto;align-items:start;width:min(100%,420px);margin:auto;overflow:visible';
      document.body.style.cssText = 'overflow:auto;height:auto;display:block';
      document.body.append(grid);
      const { ClimateNewsPanel } = await import('/src/components/ClimateNewsPanel.ts');
      const { SocialVelocityPanel } = await import('/src/components/SocialVelocityPanel.ts');
      const { DiseaseOutbreaksPanel } = await import('/src/components/DiseaseOutbreaksPanel.ts');
      const { InternetDisruptionsPanel } = await import('/src/components/InternetDisruptionsPanel.ts');
      const { EarningsCalendarPanel } = await import('/src/components/EarningsCalendarPanel.ts');
      const { EconomicCalendarPanel } = await import('/src/components/EconomicCalendarPanel.ts');
      const { MaterialEventsPanel } = await import('/src/components/MaterialEventsPanel.ts');
      const { WsbTickerScannerPanel } = await import('/src/components/WsbTickerScannerPanel.ts');
      const { Panel } = await import('/src/components/Panel.ts');
      const climate = new ClimateNewsPanel();
      const social = new SocialVelocityPanel();
      const disease = new DiseaseOutbreaksPanel();
      const internet = new InternetDisruptionsPanel();
      const earnings = new EarningsCalendarPanel();
      const economic = new EconomicCalendarPanel();
      const material = new MaterialEventsPanel();
      const wsb = new WsbTickerScannerPanel();
      const panels: InstanceType<typeof Panel>[] = [climate, social, disease, internet, earnings, economic, material, wsb];
      for (const panel of panels) grid.append(panel.getElement());
      const now = Date.now();
      const rows = Array.from({ length: 40 }, (_, i) => i);
      social.updateData(rows.map(i => ({ id: `${i}`, title: `Social headline ${i}`, subreddit: 'worldnews', url: `https://example.test/${i}`, score: 100, upvoteRatio: 0.9, numComments: 20, velocityScore: 90 - i, createdAt: now })));
      disease.updateData(rows.map(i => ({ id: `${i}`, disease: `Outbreak ${i}`, location: 'Test location', countryCode: 'US', alertLevel: 'high', summary: 'Fixture outbreak summary.', sourceUrl: 'https://example.test', publishedAt: now, sourceName: 'Test source', lat: 0, lng: 0, cases: 1 })));
      internet.setOutages(rows.map(i => ({ id: `${i}`, country: 'United States', title: `Outage ${i}`, description: 'Fixture outage', lat: 0, lon: 0, severity: 'major', pubDate: new Date(now), link: 'https://example.test', outageDate: new Date(now), categories: [], cause: '' })));
      wsb.updateData(rows.map(i => ({ symbol: `SYM${i}`, mentionCount: 100 - i, totalScore: 100, subreddits: ['wallstreetbets'], velocityScore: 90 - i })));
      await Promise.all([climate.fetchData(), earnings.fetchData(), economic.fetchData(), material.fetchData()]);
      // CSS-only list fixtures cover secondary sections whose provider/model
      // setup is unrelated to scrolling. They use the production Panel shell.
      for (const className of ['id-ddos', 'oref-wave-list', 'cascade-countries', 'risk-alerts', 'pinned-webcams-list', 'economic-content', 'deduction-panel-content']) {
        const panel = new Panel({ id: `scroll-${className}`, title: className, collapsible: true });
        const list = document.createElement('div');
        list.className = className;
        for (let i = 0; i < 20; i++) {
          const row = document.createElement('div');
          row.style.cssText = 'min-height:44px;flex-shrink:0';
          row.textContent = `Fixture row ${i}`;
          list.append(row);
        }
        panel.getElement().querySelector('.panel-content')!.replaceChildren(list);
        if (className === 'economic-content') {
          const tabs = document.createElement('div');
          tabs.className = 'panel-tabs';
          const tab = document.createElement('button');
          tab.className = 'panel-tab active';
          tab.textContent = 'Economic indicators';
          tabs.append(tab);
          list.before(tabs);
        }
        grid.append(panel.getElement());
        panels.push(panel);
      }
      return panels.map(panel => panel.getElement().dataset.panel!);
    });
    for (const id of ids) {
      const panel = page.locator(`.panel[data-panel="${id}"]`);
      const content = panel.locator('.panel-content');
      await expect(content.locator('.error-message')).toHaveCount(0);
      for (const height of [260, 580]) {
        await panel.evaluate((el, h) => { el.style.height = `${h}px`; el.style.minHeight = `${h}px`; el.style.maxHeight = `${h}px`; }, height);
        await panel.scrollIntoViewIfNeeded();
        await expect.poll(() => content.evaluate(el => el.scrollHeight - el.clientHeight), { message: `${id} content laid out` }).toBeGreaterThan(0);
        const metrics = await content.evaluate(el => ({
          height: el.scrollHeight - el.clientHeight,
          nested: [...el.querySelectorAll<HTMLElement>('*')].filter(child => {
            const style = getComputedStyle(child);
            return ['auto', 'scroll'].includes(style.overflowY) && child.scrollHeight > child.clientHeight + 1;
          }).map(child => child.className || child.tagName),
        }));
        expect.soft(metrics.nested, `${id} ${height}px nested scrollers`).toEqual([]);
        expect.soft(metrics.height, `${id} ${height}px populated content`).toBeGreaterThan(0);
        if (id === 'scroll-economic-content') {
          const tabs = content.locator('.panel-tabs');
          expect(await tabs.evaluate(el => el.clientHeight)).toBeGreaterThan(20);
          expect(await tabs.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
        }
        // Reset focus together with scroll position between resized states.
        await content.evaluate(el => { el.blur(); el.scrollTo({ top: 0, behavior: 'instant' }); });
        await expect.poll(() => content.evaluate(el => el.scrollTop), { message: `${id} scroll reset` }).toBe(0);
        if (id === 'economic-calendar') {
          const regionTabs = content.locator('button[data-region]');
          await expect(regionTabs).toHaveCount(3);
          for (const tab of await regionTabs.all()) {
            await expect(tab).toBeInViewport({ ratio: 1 });
          }
        }
        await content.focus();
        await expect(content).toBeFocused();
        await content.press('PageDown');
        await expect.poll(() => content.evaluate(el => el.scrollTop), { message: `${id} keyboard scroll` }).toBeGreaterThan(0);
        await expect.poll(() => content.evaluate(el => {
          el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
          return el.lastElementChild!.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom;
        }), { message: `${id} last content reachable` }).toBeLessThanOrEqual(1);
      }
      const collapse = panel.locator('.panel-collapse-btn');
      if (await collapse.count()) {
        await collapse.click();
        await expect(content).toBeHidden();
        await collapse.click();
        await expect(content).toBeVisible();
      }
      await content.evaluate(el => { el.scrollTop = 0; });
      await content.hover();
      await page.mouse.wheel(0, 200);
      await expect.poll(() => content.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
      if (['climate-news', 'internet-disruptions', 'wsb-ticker-scanner'].includes(id)) {
        await panel.screenshot({ path: testInfo.outputPath(`${id}-${width}.png`) });
      }
    }
    // A narrow sidebar forces horizontal overflow even when the table fits a phone.
    if (width === 1440) {
      await page.locator('[data-panel="wsb-ticker-scanner"]').evaluate(el => { el.style.width = '220px'; });
    }
    const table = page.locator('[data-panel="wsb-ticker-scanner"] .table-scroll');
    expect(await table.evaluate(el => getComputedStyle(el).overflowX)).toBe('auto');
    await table.focus();
    await expect(table).toBeFocused();
    if (width === 1440) {
      expect(await table.evaluate(el => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0);
      await table.press('ArrowRight');
      await expect.poll(() => table.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
    }
  });
}
