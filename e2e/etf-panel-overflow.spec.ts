import { expect, test } from '@playwright/test';

test.use({ hasTouch: true });

// The real panel and stylesheet, with only the ETF RPC response controlled.
for (const language of ['en', 'de']) {
  test(`ETF summary and table navigation follow panel width (${language})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.route('**/api/**', route => route.fulfill({ json: {} }));
    await page.route('**/list-etf-flows*', route => route.fulfill({ json: {
      timestamp: '2026-11-05T00:00:00Z', rateLimited: false,
      summary: { etfCount: 2, totalVolume: 2.1e9, totalEstFlow: 3.4e8, netDirection: 'NET_INFLOW', inflowCount: 1, outflowCount: 1 },
      etfs: [
        { ticker: 'IBIT', issuer: 'BlackRock', priceChange: 1.84, volume: 1.4e9, direction: 'inflow', estFlow: 4.1e8 },
        { ticker: 'GBTC', issuer: 'Grayscale', priceChange: -0.92, volume: 7e8, direction: 'outflow', estFlow: -7e7 },
      ],
    } }));
    await page.goto(`/tests/runtime-harness.html?lang=${language}`);
    await page.evaluate(async () => {
      await import('/src/styles/main.css');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const { ETFFlowsPanel } = await import('/src/components/ETFFlowsPanel.ts');
      const panel = new ETFFlowsPanel();
      (window as unknown as { etfProbe: typeof panel }).etfProbe = panel;
      document.getElementById('runtime-harness')?.remove();
      const grid = document.createElement('div');
      grid.className = 'panels-grid';
      grid.style.cssText = 'height:auto;width:350px;grid-template-columns:350px';
      document.body.appendChild(grid);
      grid.appendChild(panel.getElement());
      await panel.fetchData();
    });
    const panel = page.locator('.panel[data-panel="etf-flows"]');
    await expect(panel.locator('tbody tr')).toHaveCount(2);
    const columns = () => panel.locator('.etf-summary').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').filter(track => parseFloat(track) > 0).length);
    await expect.poll(columns).toBe(2);
    await panel.screenshot({ path: testInfo.outputPath(`etf-${language}-narrow.png`) });
    // English values can fit at 350px. A narrower sidebar exercises overflow
    // in both languages without forcing an artificial table minimum width.
    await page.locator('.panels-grid').evaluate(el => { el.style.width = '250px'; el.style.gridTemplateColumns = '250px'; });
    const nav = panel.locator('.etf-table-nav');
    const previous = nav.locator('button').first();
    const next = nav.locator('button').last();
    await expect(nav).toBeVisible();
    await expect(previous).toBeDisabled();
    await expect(next).toBeEnabled();
    await panel.screenshot({ path: testInfo.outputPath(`etf-${language}-overflow.png`) });
    await next.focus();
    await page.keyboard.press('Enter');
    await expect(next).toBeDisabled();
    await expect(previous).toBeEnabled();
    const scroller = panel.locator('.etf-table-wrap');
    expect(await scroller.evaluate(el => {
      const cell = el.querySelector('tbody tr td:last-child')!.getBoundingClientRect();
      return cell.right <= el.getBoundingClientRect().right + 1;
    })).toBe(true);
    await expect(panel.locator('tbody tr').first()).toContainText('+1.84%');
    await previous.tap();
    await expect(previous).toBeDisabled();
    await scroller.focus();
    const keyboardScrollEnd = scroller.evaluate(el => new Promise<void>(resolve => el.addEventListener('scrollend', () => resolve(), { once: true })));
    await page.keyboard.press('ArrowRight');
    await keyboardScrollEnd;
    await expect.poll(() => scroller.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
    await previous.click();
    await expect(previous).toBeDisabled();
    await scroller.hover();
    await page.mouse.wheel(300, 0);
    await expect.poll(() => scroller.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
    await page.evaluate(async () => {
      const panel = (window as unknown as { etfProbe: { showLocked(): void; fetchData(): Promise<void>; unlockPanel(): void } }).etfProbe;
      panel.showLocked();
      await panel.fetchData();
      panel.unlockPanel();
    });
    await expect(previous).toBeDisabled();
    await next.click();
    await expect(next).toBeDisabled();
    await previous.click();
    await expect(previous).toBeDisabled({ timeout: 5000 });

    // Resize the panel, leaving the desktop viewport unchanged.
    await page.locator('.panels-grid').evaluate(el => { el.style.width = '900px'; el.style.gridTemplateColumns = '900px'; });
    await expect.poll(columns).toBe(4);
    await expect(nav).toBeHidden();
    await panel.screenshot({ path: testInfo.outputPath(`etf-${language}-wide.png`) });
    await page.locator('.panels-grid').evaluate(el => { el.style.width = '350px'; el.style.gridTemplateColumns = '350px'; });
    await panel.evaluate(el => el.style.setProperty('--wm-panel-effective-scale', '1.5'));
    await expect(nav).toBeVisible();
    await expect.poll(columns).toBe(2);
    const geometry = await panel.evaluate(el => {
      const content = el.querySelector('.panel-content')!;
      return {
        overflow: content.scrollWidth - content.clientWidth,
        clipped: [...el.querySelectorAll('.etf-summary-label, .etf-summary-value')].some(item => item.scrollWidth > item.clientWidth),
      };
    });
    expect(geometry).toEqual({ overflow: 0, clipped: false });
    await panel.screenshot({ path: testInfo.outputPath(`etf-${language}-scaled.png`) });
    // A long translated word must also stay inside a scaled, narrow button.
    await page.locator('.panels-grid').evaluate(el => { el.style.width = '250px'; el.style.gridTemplateColumns = '250px'; });
    const labels = await nav.locator('button').evaluateAll(buttons => {
      const labels = buttons.map(button => button.textContent);
      buttons[0]!.textContent = 'Safu wima zilizotangulia';
      buttons[1]!.textContent = 'Safu wima zaidi';
      return labels;
    });
    expect(await nav.locator('button').evaluateAll(buttons => buttons.map(button => button.scrollWidth - button.clientWidth))).toEqual([0, 0]);
    await nav.locator('button').evaluateAll((buttons, labels) => buttons.forEach((button, i) => { button.textContent = labels[i]!; }), labels);
    await page.locator('.panels-grid').evaluate(el => { el.style.width = '350px'; el.style.gridTemplateColumns = '350px'; });
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.evaluate(el => el.style.setProperty('--wm-panel-effective-scale', '1'));
    await expect.poll(columns).toBe(2);
    await panel.screenshot({ path: testInfo.outputPath(`etf-${language}-mobile.png`) });
  });
}
