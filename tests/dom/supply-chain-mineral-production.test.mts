import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const { SupplyChainPanel } = await import('@/components/SupplyChainPanel');

beforeAll(async () => {
  await initTestI18n();
});

describe('SupplyChainPanel mineral production entitlement clear', () => {
  let panel: InstanceType<typeof SupplyChainPanel>;

  beforeEach(() => {
    document.body.replaceChildren();
    vi.useFakeTimers();
    panel = new SupplyChainPanel();
    document.body.appendChild(panel.getElement());
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('retains free mineral deposits when premium production data is cleared', async () => {
    panel.updateCriticalMinerals({
      minerals: [{
        mineral: 'Lithium',
        topProducers: [{ country: 'Australia', countryCode: 'AU', sharePct: 48, productionTonnes: 86_000 }],
        hhi: 2400,
        riskRating: 'high',
        globalProduction: 180_000,
        unit: 'tonnes',
      }],
      fetchedAt: '2026-08-30T00:00:00.000Z',
      upstreamUnavailable: false,
    });
    panel.updateMineralProduction({
      commodities: [{
        commodity: 'Lithium',
        commodityId: 'lithium',
        year: 2025,
        unit: 'tonnes',
        mine: { countries: [], hhi: 2400, withheldCount: 0, year: 2025, unit: 'tonnes' },
        refinery: undefined,
        sources: ['USGS'],
      }],
      countries: [],
      fetchedAt: '2026-08-30T00:00:00.000Z',
      upstreamUnavailable: false,
      dataYear: 2025,
    });
    await vi.advanceTimersByTimeAsync(151);
    panel.getElement().querySelector<HTMLElement>('[data-tab="minerals"]')?.click();
    await vi.advanceTimersByTimeAsync(151);
    expect(panel.getElement().textContent).toContain('Country shares of actual production');

    panel.clearMineralProduction();
    await vi.advanceTimersByTimeAsync(151);

    const text = panel.getElement().textContent ?? '';
    expect(text).toContain('Lithium');
    expect(text).toContain('Australia 48%');
    expect(text).not.toContain('Country shares of actual production');
  });
});
