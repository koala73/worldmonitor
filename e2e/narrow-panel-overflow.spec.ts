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
    const { NationalDebtPanel } = await import('/src/components/NationalDebtPanel.ts');
    const { InvestmentsPanel } = await import('/src/components/InvestmentsPanel.ts');
    const { CommoditiesPanel } = await import('/src/components/MarketPanel.ts');
    const { RegionalIntelligenceBoard } = await import('/src/components/RegionalIntelligenceBoard.ts');

    document.getElementById('runtime-harness')?.remove();
    const grid = document.createElement('div');
    grid.className = 'panels-grid';
    grid.style.boxSizing = 'content-box';
    grid.style.height = 'auto';
    document.body.appendChild(grid);

    // The real board, rendered from a full snapshot with the regime history,
    // weekly brief and fallback notice it adds around the snapshot blocks.
    const regional = new RegionalIntelligenceBoard();
    grid.appendChild(regional.getElement());
    // Drop the board's own snapshot requests (no API here) so they cannot replace the fixture.
    (regional as unknown as { latestSequence: number }).latestSequence = Number.MAX_SAFE_INTEGER;
    const lane = (name: string, probability: number) => ({ name, probability, triggerIds: [], consequences: [], transmissions: [] });
    const path = (start: string, mechanism: string, end: string, severity: string, confidence: number) => ({
      start, mechanism, end, severity, corridorId: start, confidence, latencyHours: 12, impactedAssetClass: 'commodity',
      impactedRegions: ['mena'], magnitudeLow: 0, magnitudeHigh: 0, magnitudeUnit: 'pct', templateId: 't', templateVersion: '1.0.0',
    });
    const text = (t: string) => ({ text: t, evidenceIds: ['ev1', 'ev2'] });
    regional.renderBoard({
      regionId: 'mena',
      generatedAt: Date.UTC(2026, 10, 1),
      meta: {
        snapshotId: 'snap-1', modelVersion: '0.1.0', scoringVersion: '1.0.0', geographyVersion: '1.0.0', snapshotConfidence: 0.92,
        missingInputs: [], staleInputs: [], validUntil: 0, triggerReason: 'scheduled_6h', narrativeProvider: 'openrouter', narrativeModel: 'deepseek/deepseek-v4-flash',
      },
      regime: { label: 'coercive_stalemate', previousLabel: 'calm', transitionedAt: Date.UTC(2026, 9, 28), transitionDriver: 'cross_source_surge' },
      balance: {
        coercivePressure: 0.62, domesticFragility: 0.41, capitalStress: 0.33, energyVulnerability: 0.28,
        allianceCohesion: 0.3, maritimeAccess: 0.73, energyLeverage: 1, netBalance: -0.12, pressures: [], buffers: [],
      },
      actors: [
        { actorId: 'IR', name: 'Islamic Republic of Iran', role: 'aggressor', leverageDomains: ['military', 'energy'], leverageScore: 0.85, delta: 0.05, evidenceIds: [] },
        { actorId: 'SA', name: 'Kingdom of Saudi Arabia', role: 'broker', leverageDomains: ['energy'], leverageScore: 0.65, delta: -0.02, evidenceIds: [] },
      ],
      leverageEdges: [],
      scenarioSets: ['24h', '7d', '30d'].map((horizon) => ({
        horizon,
        lanes: [lane('base', 0.44), lane('containment', 0.33), lane('escalation', 0.12), lane('fragmentation', 0.11)],
      })),
      transmissionPaths: [
        path('hormuz', 'naval_posture', 'crude_oil', 'high', 0.85),
        path('babelm', 'shipping_disruption', 'container_freight', 'medium', 0.6),
      ],
      triggers: {
        active: [{ id: 'mena_coercive_high', description: 'Coercive pressure crossed 0.7 for two consecutive snapshots', activated: true, activatedAt: 0, scenarioLane: 'escalation', evidenceIds: [] }],
        watching: [], dormant: [],
      },
      evidence: [],
      narrative: {
        situation: text('Iran flexes naval posture near the Strait of Hormuz while Gulf states hedge.'),
        balanceAssessment: text('Pressures edge ahead of buffers.'),
        outlook24h: text('Base case dominates.'),
        outlook7d: text('Escalation risk rises over the coming week.'),
        outlook30d: text('Uncertainty widens.'),
        watchItems: [text('Hormuz transit counts below seasonal norms.')],
      },
    } as never, [
      { regionId: 'mena', label: 'coercive_stalemate', previousLabel: 'calm', transitionedAt: Date.UTC(2026, 9, 28), transitionDriver: 'cross_source_surge', snapshotId: 's2' },
      { regionId: 'mena', label: 'calm', previousLabel: 'escalation_ladder', transitionedAt: Date.UTC(2026, 9, 2), transitionDriver: 'de_escalation_signal', snapshotId: 's1' },
    ] as never, {
      regionId: 'mena', generatedAt: Date.UTC(2026, 10, 1), periodStart: Date.UTC(2026, 9, 25), periodEnd: Date.UTC(2026, 10, 1),
      situationRecap: 'Naval posture hardened through the week.', regimeTrajectory: 'calm → coercive_stalemate',
      keyDevelopments: ['Two tanker seizures near Hormuz', 'Saudi–Iran channel reopened'], riskOutlook: 'Elevated into next week.',
      provider: 'openrouter', model: 'deepseek/deepseek-v4-flash',
    } as never, 'europe');

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
    for (const panel of [debt, investments, commodities]) grid.appendChild(panel.getElement());
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

const legacyTechReadiness = [
  {
    country: 'SXM', countryName: 'Sint Maarten (Dutch part)', score: 100, rank: 1,
    components: { internet: null, mobile: 100, broadband: null, rdSpend: null },
  },
  {
    country: 'KOR', countryName: 'Korea, Rep.', score: 98.1, rank: 2,
    components: { internet: 97.9, mobile: 100, broadband: 95.6, rdSpend: 98.87 },
  },
  {
    country: 'MCO', countryName: 'Monaco', score: 93, rank: 5,
    components: { internet: 99, mobile: 71.6, broadband: 100, rdSpend: null },
  },
];

for (const { mode, width, hydrate } of [
  { mode: 'desktop', width: 420, hydrate: true },
  { mode: 'mobile', width: 271, hydrate: false },
]) {
  test(`tech readiness corrects legacy rankings on ${mode}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: hydrate ? 1280 : 390, height: 720 });
    let fallbackRequests = 0;
    await page.route(url => url.pathname === '/api/bootstrap' && url.searchParams.get('keys') === 'techReadiness', async route => {
      fallbackRequests += 1;
      await route.fulfill({ json: { data: { techReadiness: legacyTechReadiness }, missing: [] } });
    });
    await page.goto('/tests/runtime-harness.html');
    await page.evaluate(async ({ hydrate, width, fixture }) => {
      await import('/src/styles/main.css');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      if (hydrate) {
        const { __testing__ } = await import('/src/services/bootstrap.ts');
        __testing__.seedHydrationCacheForTests({ techReadiness: fixture });
      }
      const { TechReadinessPanel } = await import('/src/components/TechReadinessPanel.ts');
      document.getElementById('runtime-harness')?.remove();
      const grid = document.createElement('div');
      grid.className = 'panels-grid';
      grid.style.cssText = `box-sizing:content-box;height:auto;width:${width}px;grid-template-columns:${width}px`;
      document.body.appendChild(grid);
      const panel = new TechReadinessPanel();
      grid.appendChild(panel.getElement());
      await panel.refresh();
    }, { hydrate, width, fixture: legacyTechReadiness });

    const panel = page.locator('[data-panel="tech-readiness"]');
    const rows = panel.locator('.readiness-item');
    await expect(rows.locator('.readiness-name')).toHaveText(['Korea, Rep.', 'Monaco', 'Sint Maarten (Dutch part)']);
    await expect(rows.locator('.readiness-rank')).toHaveText(['#1', '#2', '—']);
    await expect(rows.locator('.readiness-score')).toHaveText(['98.1', '93', '—']);
    await expect(rows.locator('.readiness-coverage')).toHaveText(['4/4', '3/4', '1/4']);
    await expect(panel.locator('.readiness-coverage-summary')).toContainText('Ranked 2 · Unranked 1');
    await expect(panel.locator('.readiness-coverage-summary')).toContainText('Minimum coverage to rank · 3/4');
    expect(fallbackRequests).toBe(hydrate ? 0 : 1);
    const content = panel.locator('.panel-content');
    expect(await content.evaluate(el => el.scrollWidth)).toBeLessThanOrEqual(await content.evaluate(el => el.clientWidth));
    await panel.screenshot({ path: testInfo.outputPath(`tech-readiness-${mode}.png`) });
  });
}
