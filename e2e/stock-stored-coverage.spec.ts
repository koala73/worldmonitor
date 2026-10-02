import { expect, test } from '@playwright/test';

for (const count of [12, 50]) {
  test(`stored stock panels preserve ${count} mixed-case targets across partial refresh and failure`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1280, height: 1200 });
    await page.goto('/tests/runtime-harness.html');
    await page.evaluate(async (count) => {
      await import('/src/styles/main.css');
      const [{ DataLoaderManager }, { StockBacktestPanel }, { StockAnalysisPanel }, { setProKey }] = await Promise.all([
        import('/src/app/data-loader.ts'), import('/src/components/StockBacktestPanel.ts'),
        import('/src/components/StockAnalysisPanel.ts'), import('/src/services/widget-store.ts'),
      ]);
      const { _setTestProviders } = await import('/src/services/premium-fetch.ts');
      _setTestProviders({ getTesterKey: () => 'fixture', getClerkToken: async () => null });
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const symbols = Array.from({ length: count }, (_, i) => `SYM${i}`);
      localStorage.setItem('wm-market-watchlist-v1', JSON.stringify([...symbols.map((symbol, i) => ({
        symbol: i % 2 ? symbol.toLowerCase() : symbol, name: symbol, display: symbol,
      })), ...(count === 12 ? [{ symbol: 'sym0', name: 'Duplicate case', display: 'SYM0' }] : [])]));
      const liveRequests: string[] = [];
      let fail = false;
      const snapshot = (symbol: string, stale = false) => ({
        available: true, symbol, name: symbol, display: symbol, currency: 'USD',
        generatedAt: new Date(Date.now() - (stale ? 172800000 : 60000)).toISOString(),
        currentPrice: 100, signal: 'Hold', signalScore: 50, compositeScore: 50,
        ratingSignal: 'Hold', ratingSummary: 'Controlled fixture', ratingAction: 'Monitor',
        ratingConfidence: 'Medium', ratingWhyNow: 'Stable', ratingBullishFactors: [], ratingRiskFactors: [],
        analystConsensus: {}, fundamentals: {}, bullishFactors: [], riskFactors: [], headlines: [],
        supportLevels: [], resistanceLevels: [], recentUpgrades: [],
        latestSignal: 'Hold', winRate: 60, directionAccuracy: 60, avgSimulatedReturnPct: 2,
        actionableEvaluations: 10, totalSignals: 10, evalWindowDays: 10, results: [], warnings: [],
      });
      window.fetch = async (input) => {
        const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const url = new URL(raw, location.origin);
        let body: unknown = {};
        if (url.pathname === '/api/wm-session') {
          // setProKey resolves only after the HttpOnly key-session mint succeeds (#8269).
          body = { exp: Date.now() + 3_600_000 };
        } else if (url.pathname.endsWith('/get-stock-analysis-history')) {
          body = { items: symbols.map((symbol, i) => ({ symbol, snapshots: [snapshot(symbol, i === count - 1)] })) };
        } else if (url.pathname.endsWith('/list-stored-stock-backtests')) {
          body = { items: symbols.map((symbol, i) => snapshot(symbol, i === count - 1)) };
        } else if (url.pathname.endsWith('/analyze-stock') || url.pathname.endsWith('/backtest-stock')) {
          const symbol = url.searchParams.get('symbol')!;
          liveRequests.push(symbol);
          if (fail) return new Response('{}', { status: 503 });
          body = snapshot(symbol.toUpperCase());
        }
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      };
      if (!(await setProKey('controlled-fixture-key'))) throw new Error('fixture Pro key session was not established');
      const backtest = new StockBacktestPanel();
      const analysis = new StockAnalysisPanel();
      const ctx = { panels: { 'stock-backtest': backtest, 'stock-analysis': analysis } };
      const loader = new DataLoaderManager(ctx as never, { renderCriticalBanner() {}, refreshOpenCountryBrief() {} });
      document.body.replaceChildren();
      const label = document.createElement('h1');
      label.textContent = `Controlled Pro fixture: ${count} mixed-case symbols`;
      const button = document.createElement('button');
      button.textContent = 'Refresh stock panels';
      const status = document.createElement('output');
      status.id = 'fixture-status';
      button.onclick = async () => {
        status.textContent = 'Loading';
        liveRequests.length = 0;
        await loader.loadStockAnalysis();
        await loader.loadStockBacktest();
        status.textContent = JSON.stringify(liveRequests);
        fail = true;
      };
      document.body.append(label, button, status, analysis.getElement(), backtest.getElement());
      for (const panel of [analysis, backtest]) {
        panel.getElement().style.cssText = 'width:100%;height:500px;margin:16px 0;';
      }
    }, count);
    await page.getByRole('button', { name: 'Refresh stock panels', exact: true }).click();
    await expect(page.locator('#fixture-status')).toHaveText(JSON.stringify([`sym${count - 1}`, `sym${count - 1}`]));
    await expect(page.locator('[data-panel="stock-analysis"]')).toContainText(`${count} symbols`);
    await expect(page.locator('[data-panel="stock-backtest"]')).toContainText(`${count} symbols`);
    for (const id of ['stock-analysis', 'stock-backtest']) {
      // Match the row key exactly: a substring match on 'SYM0' also hits SYM01..SYM09.
      const row = page.locator(`[data-panel="${id}"] tr.watchlist-row[data-rowkey="SYM0"]`);
      await expect(row).toHaveCount(1);
      await expect(row).toBeVisible();
    }
    await page.screenshot({ path: testInfo.outputPath(`stock-${count}-partial.png`), fullPage: true });
    await page.getByRole('button', { name: 'Refresh stock panels', exact: true }).click();
    await expect(page.locator('#fixture-status')).toHaveText(JSON.stringify([`sym${count - 1}`, `sym${count - 1}`]));
    await expect(page.locator('[data-panel="stock-analysis"]')).toContainText(`${count} symbols`);
    await expect(page.locator('[data-panel="stock-backtest"]')).toContainText(`${count} symbols`);
    for (const id of ['stock-analysis', 'stock-backtest']) {
      // Match the row key exactly: a substring match on 'SYM0' also hits SYM01..SYM09.
      const row = page.locator(`[data-panel="${id}"] tr.watchlist-row[data-rowkey="SYM0"]`);
      await expect(row).toHaveCount(1);
      await expect(row).toBeVisible();
    }
    await page.screenshot({ path: testInfo.outputPath(`stock-${count}-fallback.png`), fullPage: true });
    for (const id of ['stock-analysis', 'stock-backtest']) {
      const panel = page.locator(`[data-panel="${id}"]`);
      await panel.getByRole('textbox').fill(`SYM${count - 1}`);
      await expect(panel.locator('tr.watchlist-row')).toHaveCount(1);
      await expect(panel.locator(`tr.watchlist-row[data-rowkey="SYM${count - 1}"]`)).toHaveCount(1);
    }
  });
}
