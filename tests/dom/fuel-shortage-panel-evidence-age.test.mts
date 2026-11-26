/**
 * #11272: the fuel-shortage registry is hand-curated and republished daily,
 * so rows confirmed months ago must read as old, not as active shortages
 * under a fresh timestamp, and product and cause keys must read as words.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { FuelShortagePanel } from '@/components/FuelShortagePanel';
import { getCachedFuelShortageRegistry } from '@/shared/fuel-shortage-registry-store';

const listFuelShortages = vi.fn();

vi.mock('@/shared/fuel-shortage-registry-store', () => ({
  getCachedFuelShortageRegistry: vi.fn(() => ({ registry: undefined })),
  setCachedFuelShortageRegistry: vi.fn(),
}));

vi.mock('@/services/generated-rpc-clients', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  SupplyChainServiceClient: class {
    listFuelShortages = (...args: unknown[]) => listFuelShortages(...args);
    getFuelShortageDetail = async () => ({ shortage: null });
  },
}));

const NOW = new Date('2026-11-25T00:00:00Z');

const SHORTAGES = [
  {
    id: 'pk-petrol', country: 'PK', product: 'petrol', severity: 'confirmed',
    firstSeen: '2026-01-12T00:00:00Z', lastConfirmed: '2026-04-15T00:00:00Z', resolvedAt: '',
    impactTypes: ['stations_closed'], causeChain: ['policy', 'logistics'], shortDescription: '',
  },
  {
    id: 'de-heating', country: 'DE', product: 'heating_oil', severity: 'watch',
    firstSeen: '2026-11-01T00:00:00Z', lastConfirmed: '2026-11-20T00:00:00Z', resolvedAt: '',
    impactTypes: ['price_spike'], causeChain: ['import_cut', 'upstream_refinery'], shortDescription: '',
  },
];

let panel: FuelShortagePanel;

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  listFuelShortages.mockReset();
  vi.mocked(getCachedFuelShortageRegistry).mockReturnValue({ registry: undefined } as never);
  panel = new FuelShortagePanel({ getFuelShortageDetail: async () => ({ shortage: undefined }) as never });
  document.body.appendChild(panel.getElement());
});

afterEach(() => {
  panel.destroy();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

const el = () => panel.getElement();
const row = (id: string) => el().querySelector<HTMLElement>(`tr.fs-row[data-shortage-id="${id}"]`)!;
const confirmedCell = (id: string) => row(id).querySelector<HTMLElement>('[data-label="Last confirmed"]')!;

describe('FuelShortagePanel evidence age and labels', () => {
  it('shows each row’s last confirmation, marks old ones, and puts the recent row first', async () => {
    listFuelShortages.mockResolvedValue({
      shortages: SHORTAGES, fetchedAt: '2026-11-20T00:00:00Z', classifierVersion: 'v1', upstreamUnavailable: false,
    });
    await panel.fetchData();

    expect(confirmedCell('de-heating').textContent?.trim()).toBe('2026-11-20');
    expect(confirmedCell('de-heating').querySelector('.fs-stale')).toBeNull();
    expect(confirmedCell('pk-petrol').querySelector('.fs-stale')?.textContent).toBe('2026-04-15 · 224d ago');
    expect([...el().querySelectorAll<HTMLElement>('tr.fs-row')].map(r => r.dataset.shortageId))
      .toEqual(['de-heating', 'pk-petrol']);
    expect(el().querySelector('.fs-summary')?.textContent).toBe('1 confirmed · 1 watch · 1 not reconfirmed in 14 days');
    expect(el().textContent).not.toContain('active shortages');
  });

  it('dates bootstrap data by the newest confirmation, not the registry republish time', async () => {
    vi.mocked(getCachedFuelShortageRegistry).mockReturnValue({
      registry: {
        updatedAt: '2026-11-24T07:32:26.870Z',
        classifierVersion: 'v1',
        shortages: Object.fromEntries(SHORTAGES.map(s => [s.id, { ...s, resolvedAt: null }])),
      },
    } as never);
    listFuelShortages.mockResolvedValue({ shortages: [], upstreamUnavailable: true });
    await panel.fetchData();

    const footer = el().querySelector('.panel-attribution-footer')?.textContent ?? '';
    expect(footer).toContain('2 shortages');
    expect(footer).toContain('updated 5d ago');
  });

  it.each(['rpc', 'bootstrap', 'refresh'])('renders a valid empty registry from %s', async (source) => {
    if (source !== 'rpc') {
      vi.mocked(getCachedFuelShortageRegistry).mockReturnValue({
        registry: {
          shortages: source === 'bootstrap' ? {} : Object.fromEntries(SHORTAGES.map(s => [s.id, s])),
        },
      } as never);
    }
    listFuelShortages.mockResolvedValue({
      shortages: [], fetchedAt: NOW.toISOString(), classifierVersion: 'v1', upstreamUnavailable: false,
    });
    if (source === 'bootstrap') listFuelShortages.mockRejectedValue(new Error('offline'));
    await panel.fetchData();

    expect(el().querySelector('.fs-summary')?.textContent).toBe('0 confirmed · 0 watch');
    expect(el().querySelectorAll('tr.fs-row')).toHaveLength(0);
  });

  it('renders product and cause names instead of enum keys', async () => {
    listFuelShortages.mockResolvedValue({
      shortages: SHORTAGES, fetchedAt: '2026-11-20T00:00:00Z', classifierVersion: 'v1', upstreamUnavailable: false,
    });
    await panel.fetchData();

    expect(row('de-heating').querySelector('.fs-name')?.textContent).toContain('DE · Heating oil');
    expect(row('de-heating').querySelector('.fs-sub')?.textContent).toBe('Import cut · Upstream refinery');
    expect(row('pk-petrol').querySelector('.fs-sub')?.textContent).toBe('Policy · Logistics');
    expect(el().textContent).not.toMatch(/heating_oil|import_cut|upstream_refinery/);
  });
});
