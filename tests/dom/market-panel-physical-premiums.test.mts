import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const { CommoditiesPanel } = await import('@/components/MarketPanel');

const CONTENT_DEBOUNCE_MS = 150;
let panel: InstanceType<typeof CommoditiesPanel>;

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS + 1);
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  document.body.replaceChildren();
  vi.useFakeTimers();
  panel = new CommoditiesPanel();
  document.body.appendChild(panel.getElement());
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('CommoditiesPanel physical-premium tab', () => {
  it('shows raw SGE and COMEX legs, premium, source, and physical observation date', async () => {
    panel.renderCommodities([
      { symbol: 'GC=F', display: 'Gold', price: 4455.6, change: 0.5 },
    ]);
    panel.updatePhysicalPremiums({
      premiums: [{
        metal: 'gold',
        physical: {
          price: 953.88,
          currency: 'CNY',
          unit: 'gram',
          source: 'Shanghai Gold Exchange SHAU PM benchmark',
          asOf: '2026-08-18',
        },
        paper: {
          price: 4455.6,
          currency: 'USD',
          unit: 'troy ounce',
          source: 'COMEX GC=F futures snapshot',
          asOf: '2026-08-18T12:22:24.000Z',
        },
        premiumUsdPerOz: -46.7889,
        premiumPct: -1.0501,
        computedAt: '2026-08-18T12:30:00.000Z',
      }],
      fx: {
        pair: 'CNY/USD',
        rate: 0.1486,
        source: 'shared:fx-rates:v1',
        asOf: '2026-08-18T12:28:48.000Z',
      },
    });
    await flush();

    const tab = panel.getElement().querySelector<HTMLElement>('[data-tab="physical"]');
    expect(tab?.textContent).toContain('Physical premium');
    tab?.click();
    await flush();

    const text = panel.getElement().textContent ?? '';
    expect(text).toContain('Physical: CNY 953.88/g');
    expect(text).toContain('Paper: $4,455.60/oz');
    expect(text).toContain('Premium: -$46.79/oz (-1.05%)');
    expect(text).toContain('Shanghai Gold Exchange SHAU PM benchmark');
    expect(text).toContain('As of 2026-08-18');
  });

  it('keeps the Physical tab when commodities fail and FX is empty', async () => {
    panel.renderCommodities([]);
    panel.updatePhysicalPremiums({
      premiums: [{
        metal: 'gold',
        physical: {
          price: 953.88,
          currency: 'CNY',
          unit: 'gram',
          source: 'Shanghai Gold Exchange SHAU PM benchmark',
          asOf: '2026-08-18',
        },
        paper: {
          price: 4455.6,
          currency: 'USD',
          unit: 'troy ounce',
          source: 'COMEX GC=F futures snapshot',
          asOf: '2026-08-18T12:22:24.000Z',
        },
        premiumUsdPerOz: -46.7889,
        premiumPct: -1.0501,
        computedAt: '2026-08-18T12:30:00.000Z',
      }],
      fx: {
        pair: 'CNY/USD',
        rate: 0.1486,
        source: 'shared:fx-rates:v1',
        asOf: '2026-08-18T12:28:48.000Z',
      },
    });
    await flush();

    const root = panel.getElement();
    expect(root.querySelector('[data-tab="physical"]')).not.toBeNull();
    expect(root.querySelector('.panel-error-state')).toBeNull();
    expect(root.textContent).toContain('Commodities data temporarily unavailable');
  });
});
