import { expect, test } from '@playwright/test';

// The sidebar's narrowest two-column layout gives each panel about 271px
// (repeat(auto-fill, minmax(270px, 1fr)) at 1400). A signed-in audit found
// these bodies scrolling sideways there:
// - Regional Intelligence: the balance vector's two halves hold 110px + 40px
//   label/value tracks each, and the three scenario columns cannot shrink
//   below "fragmentation" (96px over at 271px, still 17px over at 350px).
// - National Debt: a fixed 110px search box beside the sort tabs (40px over).
// - GCC Investments: country, sector, status and year on one unwrapped row.
// - Commodities: four tabs in a flex row with no sideways scroll.

test.use({ viewport: { width: 1600, height: 900 } });

test('panels fit the narrowest sidebar column without scrolling sideways', async ({ page }) => {
  await page.goto('/tests/runtime-harness.html');

  const result = await page.evaluate(async () => {
    await import('/src/styles/main.css');
    const { initI18n } = await import('/src/services/i18n.ts');
    await initI18n();
    const { Panel } = await import('/src/components/Panel.ts');
    const { NationalDebtPanel } = await import('/src/components/NationalDebtPanel.ts');
    const { InvestmentsPanel } = await import('/src/components/InvestmentsPanel.ts');
    const { CommoditiesPanel } = await import('/src/components/MarketPanel.ts');
    const { buildBalanceBlock, buildScenariosBlock } = await import('/src/components/regional-intelligence-board-utils.ts');

    document.getElementById('runtime-harness')?.remove();
    const grid = document.createElement('div');
    grid.className = 'panels-grid';
    grid.style.boxSizing = 'content-box';
    grid.style.height = 'auto';
    document.body.appendChild(grid);

    const regional = new Panel({ id: 'probe-regional', title: 'Regional Intelligence' });
    const lane = (name: string, probability: number) => ({ name, probability });
    regional.getElement().querySelector('.panel-content')!.innerHTML = buildBalanceBlock({
      coercivePressure: 0.62, domesticFragility: 0.41, capitalStress: 0.33, energyVulnerability: 0.28,
      allianceCohesion: 0.3, maritimeAccess: 0.73, energyLeverage: 1, netBalance: -0.12,
    } as never) + buildScenariosBlock(['24h', '7d', '30d'].map((horizon) => ({
      horizon,
      lanes: [lane('base', 0.44), lane('containment', 0.33), lane('escalation', 0.12), lane('fragmentation', 0.11)],
    })) as never);

    const debt = new NationalDebtPanel();
    const debtInternals = debt as unknown as { entries: unknown[]; applyFilters(): void; render(): void };
    debtInternals.entries = ['USA', 'JPN', 'CHN', 'GBR', 'FRA'].map((iso3, i) => ({
      iso3, debtUsd: 3e13 / (i + 1), gdpUsd: 2.5e13 / (i + 1), debtToGdp: 120 - i * 10, annualGrowth: 4 - i,
      perSecondRate: 1000, perDayRate: 8.64e7, baselineTs: String(Date.UTC(2024, 0, 1)), source: 'IMF WEO 2026',
    }));
    debtInternals.applyFilters();
    debtInternals.render();

    const investments = new InvestmentsPanel(() => {});

    const commodities = new CommoditiesPanel();
    const commodityInternals = commodities as unknown as { _physicalPremiums: unknown[] };
    commodityInternals._physicalPremiums = [{}];
    commodities.updateFxRates([{ currency: 'USD', rate: 1.08, change1d: 0.1 }] as never);
    commodities.renderCommodities([
      { symbol: 'GC=F', display: 'Gold', price: 3948, change: 0.2, sparkline: [1, 2, 3] },
      { symbol: 'SI=F', display: 'Silver', price: 49.52, change: -0.48, sparkline: [3, 2, 1] },
      { symbol: 'HG=F', display: 'Copper', price: 6.33, change: -1.09, sparkline: [2, 2, 1] },
    ]);

    const panels = { regional, debt, investments, commodities };
    for (const panel of Object.values(panels)) grid.appendChild(panel.getElement());
    // setSafeContent debounces panel content by 150ms.
    await new Promise((r) => setTimeout(r, 400));

    const measure = async (width: number) => {
      grid.style.width = `${width}px`;
      grid.style.gridTemplateColumns = `${width}px`;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const out: Record<string, { overflowX: number; overhang: string[] }> = {};
      for (const [key, panel] of Object.entries(panels)) {
        const content = panel.getElement().querySelector<HTMLElement>('.panel-content')!;
        const edge = content.getBoundingClientRect().left + content.clientWidth;
        const overhang: string[] = [];
        for (const node of content.querySelectorAll<HTMLElement>('*')) {
          // A sideways scroller may hold more than it shows.
          if (node.closest('.panel-tabs') && !node.classList.contains('panel-tabs')) continue;
          const r = node.getBoundingClientRect();
          if (r.width && r.right > edge + 1) overhang.push(`${node.tagName.toLowerCase()}.${String(node.className).slice(0, 30)} "${(node.textContent ?? '').trim().slice(0, 24)}"`);
        }
        out[key] = { overflowX: content.scrollWidth - content.clientWidth, overhang: overhang.slice(0, 3) };
      }
      return out;
    };

    return { 271: await measure(271), 300: await measure(300), 330: await measure(330) };
  });

  for (const [width, panels] of Object.entries(result)) {
    for (const [key, m] of Object.entries(panels)) {
      expect.soft(m.overhang, `${key} at ${width}px: nothing runs past the body`).toEqual([]);
      expect.soft(m.overflowX, `${key} at ${width}px: the body does not scroll sideways`).toBeLessThanOrEqual(0);
    }
  }
});

// The Commodities tab row scrolls sideways at 271px. Selecting a tab
// rebuilds the panel body, and a rebuilt bar starts scrolled to the left, so
// the tab the user just picked must be scrolled back into view.
test('a selected Commodities tab stays visible in the narrow tab bar', async ({ page }) => {
  await page.goto('/tests/runtime-harness.html');

  const result = await page.evaluate(async () => {
    await import('/src/styles/main.css');
    const { initI18n } = await import('/src/services/i18n.ts');
    await initI18n();
    const { CommoditiesPanel } = await import('/src/components/MarketPanel.ts');

    document.getElementById('runtime-harness')?.remove();
    const grid = document.createElement('div');
    grid.className = 'panels-grid';
    grid.style.cssText = 'box-sizing:content-box;height:auto;width:271px;grid-template-columns:271px';
    document.body.appendChild(grid);

    const panel = new CommoditiesPanel();
    (panel as unknown as { _physicalPremiums: unknown[] })._physicalPremiums = [{}];
    panel.updateFxRates([{ currency: 'USD', rate: 1.08, change1d: 0.1 }] as never);
    panel.renderCommodities([{ symbol: 'GC=F', display: 'Gold', price: 3948, change: 0.2, sparkline: [1, 2, 3] }]);
    grid.appendChild(panel.getElement());
    const settle = () => new Promise((r) => setTimeout(r, 400));
    await settle();

    const bar = () => panel.getElement().querySelector<HTMLElement>('.panel-content > .panel-tabs')!;
    const fx = bar().querySelector<HTMLElement>('[data-tab="fx"]')!;
    const overflows = bar().scrollWidth > bar().clientWidth;
    bar().scrollLeft = bar().scrollWidth;
    fx.click();
    await settle();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const b = bar().getBoundingClientRect();
    const active = bar().querySelector<HTMLElement>('.panel-tab.active')!;
    const a = active.getBoundingClientRect();
    const atEnd = bar().scrollLeft >= bar().scrollWidth - bar().clientWidth - 1;
    return { overflows, active: active.dataset.tab, left: a.left - b.left, right: b.right - a.right, atEnd };
  });

  expect(result.overflows, 'the tab row is wider than the bar at 271px').toBe(true);
  expect(result.active).toBe('fx');
  expect(result.left, 'the selected tab starts inside the bar').toBeGreaterThanOrEqual(0);
  expect(result.right, 'the selected tab ends inside the bar').toBeGreaterThanOrEqual(0);
  // The bar fades its last 24px; only the end of the row may sit under it.
  expect(result.atEnd || result.right >= 24, 'the selected tab ends clear of the edge fade').toBe(true);
});
