import { expect, test } from '@playwright/test';

test.describe('GCC investments coverage', () => {
  test('focusInvestmentOnMap enables layer and recenters map', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { focusInvestmentOnMap } = await import('/src/services/investments-focus.ts');

      const calls: { layers: string[]; center: { lat: number; lon: number; zoom: number } | null } = {
        layers: [],
        center: null,
      };

      const map = {
        enableLayer: (layer: string) => {
          calls.layers.push(layer);
        },
        setCenter: (lat: number, lon: number, zoom: number) => {
          calls.center = { lat, lon, zoom };
        },
      };

      const mapLayers = { gulfInvestments: false };

      focusInvestmentOnMap(
        map as unknown as {
          enableLayer: (layer: 'gulfInvestments') => void;
          setCenter: (lat: number, lon: number, zoom: number) => void;
        },
        mapLayers as unknown as { gulfInvestments: boolean } & Record<string, boolean>,
        24.4667,
        54.3667
      );

      return {
        layers: calls.layers,
        center: calls.center,
        gulfInvestmentsEnabled: mapLayers.gulfInvestments,
      };
    });

    expect(result.layers).toEqual(['gulfInvestments']);
    expect(result.center).toEqual({ lat: 24.4667, lon: 54.3667, zoom: 6 });
    expect(result.gulfInvestmentsEnabled).toBe(true);
  });

  test('InvestmentsPanel supports search/filter/sort and row click callbacks', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const { InvestmentsPanel } = await import('/src/components/InvestmentsPanel.ts');
      const { GULF_INVESTMENTS } = await import('/src/config/gulf-fdi.ts');

      const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
      const pollUntil = async (pred: () => boolean, maxMs = 2000) => {
        for (let i = 0; i < maxMs / 50 && !pred(); i++) await wait(50);
      };

      const clickedIds: string[] = [];
      const panel = new InvestmentsPanel((inv) => {
        clickedIds.push(inv.id);
      });
      document.body.appendChild(panel.getElement());

      const root = panel.getElement();
      await pollUntil(() => !!root.querySelector('.fdi-search'));

      const totalRows = root.querySelectorAll('.fdi-row').length;
      const firstInvestment = GULF_INVESTMENTS[0];
      const searchToken = firstInvestment?.assetName.split(/\s+/)[0]?.toLowerCase() ?? '';

      // --- Search filter ---
      let searchEl = root.querySelector<HTMLInputElement>('.fdi-search');
      if (!searchEl) return { error: 'fdi-search not found' } as never;
      searchEl.value = searchToken;
      searchEl.dispatchEvent(new Event('input', { bubbles: true }));
      await pollUntil(() => root.querySelectorAll('.fdi-row').length !== totalRows);
      const searchRows = root.querySelectorAll('.fdi-row').length;

      // Re-query after debounced re-render (old element destroyed by innerHTML)
      searchEl = root.querySelector<HTMLInputElement>('.fdi-search')!;
      searchEl.value = '';
      searchEl.dispatchEvent(new Event('input', { bubbles: true }));
      await pollUntil(() => root.querySelectorAll('.fdi-row').length === totalRows);

      // --- Country filter ---
      const countrySelect = root.querySelector<HTMLSelectElement>(
        '.fdi-filter[data-filter="investingCountry"]'
      )!;
      countrySelect.value = 'SA';
      countrySelect.dispatchEvent(new Event('change', { bubbles: true }));
      await pollUntil(() => root.querySelectorAll('.fdi-row').length !== totalRows);
      const saRows = root.querySelectorAll('.fdi-row').length;
      const expectedSaRows = GULF_INVESTMENTS.filter((inv) => inv.investingCountry === 'SA').length;

      // --- Sort by investment desc ---
      // Re-query sort header after country filter re-render
      let investmentSort = root.querySelector<HTMLElement>('.fdi-sort[data-sort="investmentUSD"]');
      const rowsBefore1 = root.querySelector<HTMLElement>('.fdi-row')?.dataset.id;
      investmentSort?.click(); // asc
      await pollUntil(() => root.querySelector<HTMLElement>('.fdi-row')?.dataset.id !== rowsBefore1);
      // Re-query after sort re-render
      investmentSort = root.querySelector<HTMLElement>('.fdi-sort[data-sort="investmentUSD"]');
      const rowsBefore2 = root.querySelector<HTMLElement>('.fdi-row')?.dataset.id;
      investmentSort?.click(); // desc
      await pollUntil(() => root.querySelector<HTMLElement>('.fdi-row')?.dataset.id !== rowsBefore2);

      const firstRow = root.querySelector<HTMLElement>('.fdi-row');
      const firstRowId = firstRow?.dataset.id ?? null;
      const expectedTopSaId = GULF_INVESTMENTS
        .filter((inv) => inv.investingCountry === 'SA')
        .slice()
        .sort((a, b) => (b.investmentUSD ?? -1) - (a.investmentUSD ?? -1))[0]?.id ?? null;

      firstRow?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      panel.destroy();
      root.remove();

      return {
        totalRows,
        datasetSize: GULF_INVESTMENTS.length,
        searchRows,
        saRows,
        expectedSaRows,
        firstRowId,
        expectedTopSaId,
        clickedId: clickedIds[0] ?? null,
      };
    });

    expect(result.totalRows).toBe(result.datasetSize);
    expect(result.searchRows).toBeGreaterThan(0);
    expect(result.searchRows).toBeLessThanOrEqual(result.totalRows);
    expect(result.saRows).toBe(result.expectedSaRows);
    expect(result.firstRowId).toBe(result.expectedTopSaId);
    expect(result.clickedId).toBe(result.firstRowId);
  });
});
