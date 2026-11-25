/**
 * #11269 — a months-old fuel observation sat under the panel's recent
 * "Updated" fetch date with no row-level freshness. Each price cell must
 * show its own observation date, flag observations older than a monthly cycle
 * at fetch time, and name monthly means by their month.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const { fuelData } = vi.hoisted(() => ({ fuelData: { current: null as unknown } }));

vi.mock('@/services/bootstrap', () => ({ getHydratedData: () => fuelData.current }));
vi.mock('@/services/generated-rpc-clients', () => ({
  EconomicServiceClient: class { listFuelPrices = async () => fuelData.current; },
}));

import { FuelPricesPanel } from '@/components/FuelPricesPanel';

const fuel = (usdPrice: number, observedAt: string, grade = 'Regular') =>
  ({ usdPrice, localPrice: usdPrice, grade, source: 'test', available: true, wowPct: 0, observedAt });

function country(code: string, name: string, gasoline: unknown, diesel: unknown) {
  return { code, name, currency: 'USD', flag: '', fxRate: 1, gasoline, diesel };
}

function cells(panel: FuelPricesPanel, name: string): HTMLTableCellElement[] {
  const row = [...panel.getElement().querySelectorAll('tbody tr')]
    .find(r => r.querySelector('.gb-item-name')?.textContent?.includes(name));
  if (!row) throw new Error(`row ${name} missing`);
  return [...row.querySelectorAll<HTMLTableCellElement>('td.gb-cell')];
}

describe('FuelPricesPanel row-level observation dates', () => {
  beforeAll(async () => { await initTestI18n(); });
  beforeEach(() => {
    vi.useFakeTimers();
    fuelData.current = {
      fetchedAt: '2026-11-24T06:00:00.000Z',
      countries: [
        country('BF', 'Burkina Faso', fuel(1.4025, '2026-07-08', 'Super 91'), fuel(1.2375, '2026-07-08', 'Diesel')),
        country('US', 'United States', fuel(0.95, '2026-11-17'), fuel(1.05, '2026-11-17', 'Diesel')),
        country('ZM', 'Zambia', fuel(1.607, '2026-11-01', 'Petrol'), fuel(1.674, '2026-11-01', 'Diesel')),
        country('NO', 'Norway', fuel(1.9, '2026-10-01', 'RON95 (monthly mean)'), fuel(1.8, '2026-10-01', 'Diesel (monthly mean)')),
      ],
      cheapestGasoline: 'US', mostExpensiveGasoline: 'NO', cheapestDiesel: 'US', mostExpensiveDiesel: 'NO',
      wowAvailable: false, prevFetchedAt: '', sourceCount: 3, countryCount: 3,
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  async function render(): Promise<FuelPricesPanel> {
    const panel = new FuelPricesPanel();
    document.body.appendChild(panel.getElement());
    await panel.fetchData();
    await vi.runAllTimersAsync();
    return panel;
  }

  it('shows a months-old observation date with its age instead of only the fetch date', async () => {
    const [gas, diesel] = cells(await render(), 'Burkina Faso');
    for (const cell of [gas!, diesel!]) {
      expect(cell.textContent).toContain('Jul 8, 2026');
      expect(cell.textContent).toContain('139 days old');
      expect(cell.querySelector('.gb-observed-stale')).not.toBeNull();
    }
    expect(gas!.textContent).toContain('$1.403');
  });

  it('dates observations within a monthly cycle without a stale flag', async () => {
    const panel = await render();
    const [gas] = cells(panel, 'United States');
    expect(gas!.textContent).toContain('Nov 17');
    const [zmGas] = cells(panel, 'Zambia');
    expect(zmGas!.textContent).toContain('Nov 1');
    expect(zmGas!.textContent).not.toContain('days old');
    expect(gas!.textContent).not.toContain('days old');
    expect(gas!.querySelector('.gb-observed-stale')).toBeNull();
  });

  it('names a monthly mean by its month rather than its first day', async () => {
    const [gas] = cells(await render(), 'Norway');
    expect(gas!.textContent).toContain('Oct 2026 avg');
    expect(gas!.textContent).not.toContain('Oct 1');
  });
});
