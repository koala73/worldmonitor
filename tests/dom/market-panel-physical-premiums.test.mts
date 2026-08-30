import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import type {
  GetPhysicalDivergenceIndexResponse,
  PhysicalDivergenceState,
} from '@/generated/client/worldmonitor/market/v1/service_client';

const { CommoditiesPanel } = await import('@/components/MarketPanel');

const CONTENT_DEBOUNCE_MS = 150;
let panel: InstanceType<typeof CommoditiesPanel>;

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS + 1);
}

function divergenceResponse(
  state: Exclude<PhysicalDivergenceState, 'PHYSICAL_DIVERGENCE_STATE_UNSPECIFIED'>,
): GetPhysicalDivergenceIndexResponse {
  const ok = state === 'PHYSICAL_DIVERGENCE_STATE_OK';
  return {
    readings: [{
      metal: 'gold',
      state,
      reason: ok ? '' : state.toLowerCase(),
      regime: ok ? 'PHYSICAL_PREMIUM_REGIME_ELEVATED' : 'PHYSICAL_PREMIUM_REGIME_UNSPECIFIED',
      index: ok ? 62.5 : undefined,
      premiumPct: -1.0501,
      premiumUsdPerOz: -46.7889,
      percentile: ok ? 88 : undefined,
      robustZ: ok ? 1.2 : undefined,
      delta5d: ok ? 0.5 : undefined,
      delta20d: ok ? 1.4 : undefined,
      trend5d: ok ? 'PHYSICAL_PREMIUM_TREND_WIDENING' : 'PHYSICAL_PREMIUM_TREND_UNSPECIFIED',
      trend20d: ok ? 'PHYSICAL_PREMIUM_TREND_WIDENING' : 'PHYSICAL_PREMIUM_TREND_UNSPECIFIED',
      historyPoints: state === 'PHYSICAL_DIVERGENCE_STATE_INSUFFICIENT_HISTORY' ? 59 : 60,
      historyWindowStart: ok ? '2025-08-18' : '',
      historyWindowEnd: ok ? '2026-08-18' : '',
      physicalAsOf: '2026-08-18',
      paperAsOf: Date.parse('2026-08-18T12:22:24.000Z'),
      historyKey: 'market:physical-premium-history:v1:gold',
      methodologyVersion: 'physical-divergence-v2',
      provenance: {
        physicalSource: 'Shanghai Gold Exchange SHAU PM benchmark',
        physicalSymbol: 'SHAU',
        physicalAsOf: '2026-08-18',
        paperSource: 'COMEX GC=F futures snapshot',
        paperSymbol: 'GC=F',
        paperAsOf: Date.parse('2026-08-18T12:22:24.000Z'),
        fxSource: 'shared:fx-rates:v1',
        fxPair: 'CNY/USD',
        fxAsOf: Date.parse('2026-08-18T12:28:48.000Z'),
        historyKey: 'market:physical-premium-history:v1:gold',
        historyWindowPoints: 250,
        methodologyVersion: 'physical-divergence-v2',
      },
    }],
    composite: {
      state,
      reason: ok ? '' : state.toLowerCase(),
      index: ok ? 62.5 : undefined,
      weights: [
        { metal: 'gold', weight: 0.7, methodologyVersion: 'physical-divergence-v2' },
        { metal: 'silver', weight: 0.3, methodologyVersion: 'physical-divergence-v2' },
      ],
      methodologyVersion: 'physical-divergence-v2',
    },
    evaluatedAt: Date.parse('2026-08-18T12:30:00.000Z'),
    methodologyVersion: 'physical-divergence-v2',
  };
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
  it('loads once for discovery and refreshes only while unavailable or selected', () => {
    expect(panel.shouldRefreshPhysicalComparison()).toBe(true);
    panel.updatePhysicalPremiums({
      premiums: [{ metal: 'gold', premiumUsdPerOz: 1, premiumPct: 1, computedAt: '2026-08-18T12:30:00.000Z' }],
      fx: undefined,
    });
    expect(panel.shouldRefreshPhysicalComparison()).toBe(false);
    expect(panel.selectTab('physical').ok).toBe(true);
    expect(panel.shouldRefreshPhysicalComparison()).toBe(true);

    const unavailablePanel = new CommoditiesPanel();
    unavailablePanel.updatePhysicalPremiums({
      premiums: [{ metal: 'gold', premiumUsdPerOz: 1, premiumPct: 1, computedAt: '2026-08-18T12:30:00.000Z' }],
    });
    unavailablePanel.showPhysicalDivergenceUnavailable();
    expect(unavailablePanel.shouldRefreshPhysicalComparison()).toBe(true);
  });

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

    expect(panel.selectTab('commodities')).toMatchObject({ ok: true, effectiveTab: 'commodities' });
    await flush();
    expect(panel.selectTab('physical')).toEqual({
      ok: true,
      status: 'applied',
      effectiveTab: 'physical',
    });
    await flush();
    expect(panel.getActiveTab()).toBe('physical');
    expect(panel.getElement().textContent).toContain('Shanghai Gold Exchange SHAU PM benchmark');
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

  it('renders ok, insufficient-history, stale-input, and missing-input states explicitly', async () => {
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
        pair: 'CNY/USD', rate: 0.1486, source: 'shared:fx-rates:v1', asOf: '2026-08-18T12:28:48.000Z',
      },
    });
    await flush();
    panel.getElement().querySelector<HTMLElement>('[data-tab="physical"]')?.click();
    await flush();

    const cases = [
      ['PHYSICAL_DIVERGENCE_STATE_OK', ['Physical stress index: 62.5 / 100', 'Elevated', '↑ 5d', '↑ 20d']],
      ['PHYSICAL_DIVERGENCE_STATE_INSUFFICIENT_HISTORY', ['Warming up: 59 / 60 trading points']],
      ['PHYSICAL_DIVERGENCE_STATE_STALE_INPUT', ['Physical benchmark is stale']],
      ['PHYSICAL_DIVERGENCE_STATE_MISSING_INPUT', ['Divergence signal unavailable']],
    ] as const;

    for (const [state, expected] of cases) {
      panel.updatePhysicalDivergence(divergenceResponse(state));
      await flush();
      const text = panel.getElement().textContent ?? '';
      for (const value of expected) expect(text).toContain(value);
      if (state === 'PHYSICAL_DIVERGENCE_STATE_INSUFFICIENT_HISTORY') {
        const composite = panel.getElement().querySelector('.physical-divergence-composite');
        expect(composite?.textContent).toContain('Warming up: 59 / 60 trading points');
        expect(composite?.textContent).not.toContain('0 / 60');
      }
    }

    const okVariants = [
      ['PHYSICAL_PREMIUM_REGIME_NORMAL', 'PHYSICAL_PREMIUM_TREND_STABLE', 'Normal', 'var(--green)', '→'],
      ['PHYSICAL_PREMIUM_REGIME_ELEVATED', 'PHYSICAL_PREMIUM_TREND_WIDENING', 'Elevated', 'var(--yellow)', '↑'],
      ['PHYSICAL_PREMIUM_REGIME_STRESSED', 'PHYSICAL_PREMIUM_TREND_NARROWING', 'Stressed', 'var(--orange, #f97316)', '↓'],
      ['PHYSICAL_PREMIUM_REGIME_EXTREME', 'PHYSICAL_PREMIUM_TREND_WIDENING', 'Extreme', 'var(--red)', '↑'],
    ] as const;
    for (const [regime, trend, label, color, arrow] of okVariants) {
      const response = divergenceResponse('PHYSICAL_DIVERGENCE_STATE_OK');
      response.readings[0]!.regime = regime;
      response.readings[0]!.trend5d = trend;
      response.readings[0]!.trend20d = trend;
      panel.updatePhysicalDivergence(response);
      await flush();
      const root = panel.getElement();
      expect(root.textContent).toContain(label);
      expect(root.textContent).toContain(`${arrow} 5d`);
      expect(root.textContent).toContain(`${arrow} 20d`);
      expect(root.innerHTML).toContain(`border:1px solid ${color}`);
    }
  });

  it('names the stale physical, paper, and FX input', async () => {
    panel.updatePhysicalPremiums({
      premiums: [{
        metal: 'gold',
        physical: {
          price: 953.88, currency: 'CNY', unit: 'gram',
          source: 'Shanghai Gold Exchange SHAU PM benchmark', asOf: '2026-08-18',
        },
        paper: {
          price: 4455.6, currency: 'USD', unit: 'troy ounce',
          source: 'COMEX GC=F futures snapshot', asOf: '2026-08-18T12:22:24.000Z',
        },
        premiumUsdPerOz: -46.7889,
        premiumPct: -1.0501,
        computedAt: '2026-08-18T12:30:00.000Z',
      }],
      fx: {
        pair: 'CNY/USD', rate: 0.1486, source: 'shared:fx-rates:v1', asOf: '2026-08-18T12:28:48.000Z',
      },
    });
    await flush();
    panel.getElement().querySelector<HTMLElement>('[data-tab="physical"]')?.click();
    await flush();

    const cases = [
      ['physical_print_older_than_12_calendar_days', 'Physical: Expired'],
      ['paper_snapshot_older_than_36_hours', 'Paper: Expired'],
      ['fx_snapshot_older_than_60_hours', 'FX: Expired'],
    ] as const;
    for (const [reason, expected] of cases) {
      const response = divergenceResponse('PHYSICAL_DIVERGENCE_STATE_STALE_INPUT');
      response.readings[0]!.reason = reason;
      response.composite!.reason = 'member_not_ok:gold:stale_input';
      panel.updatePhysicalDivergence(response);
      await flush();
      const text = panel.getElement().textContent ?? '';
      expect(text).toContain(expected);
      expect(text).not.toContain('Physical benchmark is stale');
    }
  });

  it('fails closed for unspecified and future divergence states', async () => {
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
        pair: 'CNY/USD', rate: 0.1486, source: 'shared:fx-rates:v1', asOf: '2026-08-18T12:28:48.000Z',
      },
    });
    await flush();
    panel.getElement().querySelector<HTMLElement>('[data-tab="physical"]')?.click();
    await flush();

    const unspecified = divergenceResponse('PHYSICAL_DIVERGENCE_STATE_MISSING_INPUT');
    unspecified.readings[0]!.state = 'PHYSICAL_DIVERGENCE_STATE_UNSPECIFIED';
    expect(() => panel.updatePhysicalDivergence(unspecified)).toThrow('Physical divergence state is unspecified');

    const future = divergenceResponse('PHYSICAL_DIVERGENCE_STATE_MISSING_INPUT');
    (future.readings[0] as unknown as { state: string }).state = 'PHYSICAL_DIVERGENCE_STATE_FUTURE';
    expect(() => panel.updatePhysicalDivergence(future)).toThrow(
      'Unknown physical divergence state: PHYSICAL_DIVERGENCE_STATE_FUTURE',
    );
  });

  it('clears a prior ok index when the divergence transport fails', async () => {
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
        pair: 'CNY/USD', rate: 0.1486, source: 'shared:fx-rates:v1', asOf: '2026-08-18T12:28:48.000Z',
      },
    });
    panel.updatePhysicalDivergence(divergenceResponse('PHYSICAL_DIVERGENCE_STATE_OK'));
    await flush();
    panel.getElement().querySelector<HTMLElement>('[data-tab="physical"]')?.click();
    await flush();
    expect(panel.getElement().textContent).toContain('Physical stress index: 62.5 / 100');

    panel.showPhysicalDivergenceUnavailable();
    await flush();

    const root = panel.getElement();
    expect(root.textContent).not.toContain('Physical stress index: 62.5 / 100');
    expect(root.textContent).not.toContain('Elevated');
    expect(root.textContent).toContain('Market data temporarily unavailable');
    expect(root.querySelector('.physical-divergence-transport-error')).not.toBeNull();
  });

  it('fails closed when the premium and divergence cache cohorts do not match', async () => {
    panel.updatePhysicalPremiums({
      premiums: [{
        metal: 'gold',
        physical: {
          price: 953.88,
          currency: 'CNY',
          unit: 'gram',
          source: 'Shanghai Gold Exchange SHAU PM benchmark',
          asOf: '2026-08-19',
        },
        paper: {
          price: 4455.6,
          currency: 'USD',
          unit: 'troy ounce',
          source: 'COMEX GC=F futures snapshot',
          asOf: '2026-08-19T12:22:24.000Z',
        },
        premiumUsdPerOz: -46.7889,
        premiumPct: -1.0501,
        computedAt: '2026-08-19T12:30:00.000Z',
      }],
      fx: {
        pair: 'CNY/USD', rate: 0.1486, source: 'shared:fx-rates:v1', asOf: '2026-08-18T12:28:49.000Z',
      },
    });
    panel.updatePhysicalDivergence(divergenceResponse('PHYSICAL_DIVERGENCE_STATE_OK'));
    await flush();
    panel.getElement().querySelector<HTMLElement>('[data-tab="physical"]')?.click();
    await flush();

    const text = panel.getElement().textContent ?? '';
    expect(text).toContain('Divergence signal unavailable');
    expect(text).not.toContain('Physical stress index: 62.5 / 100');
    expect(text).not.toContain('Elevated');
  });

  it('fails closed when only the premium FX cohort clock changes', async () => {
    panel.updatePhysicalPremiums({
      premiums: [{
        metal: 'gold',
        physical: {
          price: 953.88, currency: 'CNY', unit: 'gram',
          source: 'Shanghai Gold Exchange SHAU PM benchmark', asOf: '2026-08-18',
        },
        paper: {
          price: 4455.6, currency: 'USD', unit: 'troy ounce',
          source: 'COMEX GC=F futures snapshot', asOf: '2026-08-18T12:22:24.000Z',
        },
        premiumUsdPerOz: -46.7889,
        premiumPct: -1.0501,
        computedAt: '2026-08-18T12:30:00.000Z',
      }],
      fx: {
        pair: 'CNY/USD', rate: 0.1486, source: 'shared:fx-rates:v1', asOf: '2026-08-18T12:28:49.000Z',
      },
    });
    panel.updatePhysicalDivergence(divergenceResponse('PHYSICAL_DIVERGENCE_STATE_OK'));
    await flush();
    panel.getElement().querySelector<HTMLElement>('[data-tab="physical"]')?.click();
    await flush();

    const text = panel.getElement().textContent ?? '';
    expect(text).toContain('Divergence signal unavailable');
    expect(text).not.toContain('Physical stress index: 62.5 / 100');
    expect(text).not.toContain('Elevated');
  });
});
