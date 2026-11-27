/**
 * #11272 findings 361/362: fillPctChange1d is today's fill level minus
 * yesterday's (scripts/seed-gie-gas-storage.mjs), a percentage-point
 * difference. 69.15% -> 68.91% is -0.24 pp, a relative change of about
 * -0.35%, so neither panel may label it "%".
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const { EnergyComplexPanel } = await import('@/components/EnergyComplexPanel');
const { OilInventoriesPanel } = await import('@/components/OilInventoriesPanel');

const history = [
  { date: '2026-11-22', fillPct: 68.91, gasTwh: 0 },
  { date: '2026-11-21', fillPct: 69.15, gasTwh: 0 },
];
const euGas = {
  fillPct: 68.91,
  fillPctChange1d: -0.24,
  gasDaysConsumption: 40,
  trend: 'withdrawing',
  history,
  seededAt: '0',
  updatedAt: '2026-11-22',
  unavailable: false,
};

const flush = () => vi.advanceTimersByTimeAsync(151);

beforeAll(async () => {
  await initTestI18n();
});
beforeEach(() => {
  document.body.replaceChildren();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('EU gas storage daily change unit', () => {
  it('Energy Complex labels the 1d change in percentage points', async () => {
    const panel = new EnergyComplexPanel();
    document.body.appendChild(panel.getElement());
    panel.updateEuGasStorage(euGas);
    await flush();
    const text = panel.getElement().textContent ?? '';
    expect(text).toContain('68.9%');
    expect(text).toContain('-0.24 pp 1d');
    expect(text).not.toContain('-0.24%');
  });

  it('Oil Inventories labels the daily change in percentage points', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ euGas }), { status: 200 })));
    const panel = new OilInventoriesPanel();
    document.body.appendChild(panel.getElement());
    await panel.fetchData();
    await flush();
    const text = panel.getElement().textContent ?? '';
    expect(text).toContain('Fill: 68.9% | Trend: withdrawing | -0.24 pp/d');
    expect(text).not.toContain('-0.24%');
  });
});
