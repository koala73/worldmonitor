import { afterEach, beforeAll, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const mocks = vi.hoisted(() => ({ fredBatch: vi.fn(), euCurve: vi.fn() }));

vi.mock('@/services/generated-rpc-clients', () => ({
  EconomicServiceClient: class {
    getFredSeriesBatch = mocks.fredBatch;
    getEuYieldCurve = mocks.euCurve;
  },
}));

import { YieldCurvePanel } from '@/components/YieldCurvePanel';

const US_SERIES = ['DGS1MO', 'DGS3MO', 'DGS6MO', 'DGS1', 'DGS2', 'DGS5', 'DGS10', 'DGS30'];

function series(...obs: Array<[string, number]>) {
  return { observations: obs.map(([date, value]) => ({ date, value })) };
}

function usCurve(): Record<string, ReturnType<typeof series>> {
  return Object.fromEntries(US_SERIES.map((id, i) => [id, series(['2026-11-20', 4.1 + i * 0.1], ['2026-11-21', 4.2 + i * 0.1])]));
}

async function renderPanel(results: Record<string, unknown>, tab?: 'rates'): Promise<string> {
  mocks.fredBatch.mockResolvedValue({ results });
  mocks.euCurve.mockResolvedValue({ unavailable: true });
  const panel = new YieldCurvePanel();
  document.body.appendChild(panel.getElement());
  await panel.fetchData();
  await vi.advanceTimersByTimeAsync(200);
  if (tab) {
    panel.getElement().querySelector<HTMLElement>(`[data-tab="${tab}"]`)?.click();
    await vi.advanceTimersByTimeAsync(200);
  }
  return panel.getElement().querySelector('.panel-content')?.textContent?.replace(/\s+/g, ' ') ?? '';
}

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

it('shows ECB rate changes in basis points without a negative zero', async () => {
  vi.useFakeTimers();
  const text = await renderPanel({
    ...usCurve(),
    ESTR: series(['2026-11-20', 2.444], ['2026-11-23', 2.443]),
    EURIBOR6M: series(['2026-09', 2.9215909], ['2026-10', 2.9746818]),
    EURIBOR1Y: series(['2026-09', 2.31], ['2026-10', 2.2]),
    EURIBOR3M: series(['2026-09', 2.75], ['2026-10', 2.625]),
  }, 'rates');

  expect(text).toContain('Euro short-term rate 2.44% 0bps 2026-11-23');
  expect(text).toContain('EURIBOR 6M 2.97% +5bps 2026-10');
  expect(text).toContain('EURIBOR 1Y 2.20% -11bps 2026-10');
  expect(text).toContain('EURIBOR 3M 2.63% -13bps 2026-10');
  expect(text).not.toContain('-0');
});

it('labels the current and prior US curves with their observation dates', async () => {
  vi.useFakeTimers();
  const text = await renderPanel(usCurve());

  expect(text).toContain('US (Current, 2026-11-21)');
  expect(text).toContain('US (Prior, 2026-11-20)');
});

it('shows the date span when US tenors were observed on different days', async () => {
  vi.useFakeTimers();
  const results = usCurve();
  results.DGS1MO = series(['2026-11-19', 4.1], ['2026-11-20', 4.2]);
  const text = await renderPanel(results);

  expect(text).toContain('US (Current, 2026-11-20 to 2026-11-21)');
  expect(text).toContain('US (Prior, 2026-11-19 to 2026-11-20)');
});
