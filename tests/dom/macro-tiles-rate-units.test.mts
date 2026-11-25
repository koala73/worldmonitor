/**
 * #11270: annual CPI must compare the same calendar month a year earlier,
 * rate changes read in percentage points without a signed zero, and Euro
 * Area tiles built from country averages must say which countries they average.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const { mockFredBatch, mockEurostat } = vi.hoisted(() => ({
  mockFredBatch: vi.fn(),
  mockEurostat: vi.fn(),
}));

vi.mock('@/services/generated-rpc-clients', () => ({
  EconomicServiceClient: class {
    getFredSeriesBatch = mockFredBatch;
    getChinaMacroSnapshot = vi.fn().mockRejectedValue(new Error('unavailable'));
  },
}));
vi.mock('@/services/economic', () => ({ getEurostatCountryData: mockEurostat }));
vi.mock('@/services/bootstrap', () => ({ getHydratedData: () => undefined }));

const { MacroTilesPanel } = await import('@/components/MacroTilesPanel');

type Obs = { date: string; value: number };

function monthly(from: string, values: number[]): Obs[] {
  const [y, m] = from.split('-').map(Number) as [number, number];
  return values.map((value, i) => {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    return { date: d.toISOString().slice(0, 10), value };
  });
}

// Oct 2025 CPI was never published, so Sep 2025 sits 13 observations back.
const cpi = monthly('2025-08', [323.364, 324.245, 0, 325.031, 325.252, 326.588, 327.46, 328.656, 329.5, 330.3, 331.2, 332.1, 333.0, 336.9, 337.476])
  .filter((o) => o.date !== '2025-10-01');

function fred(results: Record<string, Obs[]>) {
  return {
    results: Object.fromEntries(Object.entries(results).map(([id, observations]) => [id, { seriesId: id, observations }])),
  };
}

function metric(value: number, priorValue: number, date: string) {
  return { value, priorValue, hasPrior: true, date, unit: '%' };
}

async function render(): Promise<{ panel: InstanceType<typeof MacroTilesPanel>; text: () => string }> {
  const panel = new MacroTilesPanel();
  document.body.appendChild(panel.getElement());
  await panel.fetchData();
  await vi.advanceTimersByTimeAsync(151);
  return { panel, text: () => panel.getElement().textContent!.replace(/\s+/g, ' ') };
}

beforeAll(async () => {
  await initTestI18n();
});
beforeEach(() => {
  document.body.replaceChildren();
  vi.useFakeTimers();
  mockFredBatch.mockResolvedValue(fred({
    CPIAUCSL: cpi,
    UNRATE: [{ date: '2026-09-01', value: 4.4 }, { date: '2026-10-01', value: 4.3 }],
    FEDFUNDS: [{ date: '2026-09-01', value: 3.87 }, { date: '2026-10-01', value: 3.87 }],
    GDP: [{ date: '2026-04-01', value: 31_000 }, { date: '2026-07-01', value: 31_250 }],
    ESTR: [{ date: '2026-11-20', value: 2.444 }, { date: '2026-11-21', value: 2.443 }],
  }));
  mockEurostat.mockResolvedValue({
    unavailable: false,
    countries: {
      DE: { cpi: metric(2.3, 2.1, '2026-10'), unemployment: metric(3.9, 3.8, '2026-09') },
      FR: { cpi: metric(1.1, 1.2, '2026-10'), unemployment: metric(7.6, 7.5, '2026-09') },
      IT: { cpi: metric(1.4, 1.6, '2026-10'), unemployment: metric(6.0, 6.1, '2026-09') },
      ES: { cpi: metric(3.1, 3.0, '2026-10') },
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('macro tiles annual CPI, rate deltas and Euro Area labels', () => {
  it('leaves annual CPI unavailable when the same month a year earlier is missing', async () => {
    const { text } = await render();
    expect(text()).toContain('Consumer price inflation (annual) N/A');
    expect(text()).not.toContain('4.1%');
  });

  it('computes annual CPI against the same calendar month', async () => {
    mockFredBatch.mockResolvedValue(fred({ CPIAUCSL: monthly('2025-09', [324.245, 324.8, 325.031, 325.252, 326.588, 327.46, 328.656, 329.5, 330.3, 331.2, 332.1, 333.0, 336.9, 337.476]) }));
    const { text } = await render();
    // Oct 2026 337.476 vs Oct 2025 324.8 = 3.9%; Sep 2026 336.9 vs Sep 2025 324.245 = 3.9%.
    expect(text()).toContain('Consumer price inflation (annual) 3.9%');
    expect(text()).toContain('3.9% 0.00 pp vs prior 2026-10-01');
    const change = document.querySelector('.macro-summary-card .macro-summary-change');
    expect(change?.textContent).toBe('0.00 pp vs prior');
    expect(change?.classList.contains('neutral')).toBe(true);
  });

  it('shows rate changes in percentage points with no signed zero', async () => {
    const { panel, text } = await render();
    expect(text()).toContain('Unemployment 4.3% -0.10 pp vs prior');
    expect(text()).toContain('Fed Funds Rate 3.9% 0.00 pp vs prior');
    expect(text()).toContain('+250B vs prior');

    panel.getElement().querySelector<HTMLElement>('[data-tab="eu"]')!.click();
    await vi.advanceTimersByTimeAsync(151);
    expect(text()).toContain('Euro short-term rate 2.4% 0.00 pp vs prior');
    expect(text()).not.toMatch(/-0\.0/);
    expect(text()).not.toMatch(/\d% vs prior/);
  });

  it('rounds a half-hundredth rate move away from zero', async () => {
    mockFredBatch.mockResolvedValue(fred({
      UNRATE: [{ date: '2026-09-01', value: 0.1 }, { date: '2026-10-01', value: 0.675 }],
      FEDFUNDS: [{ date: '2026-09-01', value: 2.443 }, { date: '2026-10-01', value: 2.448 }],
    }));
    const { text } = await render();
    expect(text()).toContain('Unemployment 0.7% +0.58 pp vs prior');
    expect(text()).toContain('Fed Funds Rate 2.4% +0.01 pp vs prior');
  });

  it('names the countries behind each Euro Area average', async () => {
    const { panel, text } = await render();
    panel.getElement().querySelector<HTMLElement>('[data-tab="eu"]')!.click();
    await vi.advanceTimersByTimeAsync(151);
    expect(text()).toContain('Harmonised consumer price inflation (annual), avg of DE, FR, IT, ES 2.0%');
    expect(text()).toContain('Unemployment, avg of DE, FR, IT 5.8%');
    expect(text()).toContain('not official euro area figures');
  });
});
