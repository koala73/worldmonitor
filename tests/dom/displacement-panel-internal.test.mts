/**
 * UNHCR Displacement panel, Internal (IOM DTM) tab (#9014).
 *
 * The DTM tab must not depend on UNHCR: the two sources load independently, so
 * a UNHCR outage would otherwise hide DTM data the panel already holds. A row
 * with no placed region must not move the map to (0, 0).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { toInternalDisplacementData } from '@/services/displacement/internal';
import { toCrossBorderData } from '@/services/displacement/cross-border';
import { formatPopulation } from '@/services/displacement';
import { dataFreshness } from '@/services/data-freshness';
import type { GetInternalDisplacementResponse } from '@/generated/client/worldmonitor/displacement/v1/service_client';

import { initTestI18n, tt } from './helpers/i18n.mts';

const { DisplacementPanel } = await import('@/components/DisplacementPanel');

const RESPONSE: GetInternalDisplacementResponse = {
  operations: [
    {
      countryCode: 'SDN', countryName: 'Sudan', operation: 'Armed Clashes in Sudan (Overview)', reportingDate: '2026-07-31', roundNumber: 38, totalIdps: 8622801,
      reasons: [{ reason: 'Conflict', idps: 8622801 }],
      regions: [{ pcode: 'SD11', name: 'Kassala', idps: 13596, location: { latitude: 15.66, longitude: 35.87 } }],
      flows: [],
    },
    {
      countryCode: 'BDI', countryName: 'Burundi', operation: 'Burundi Complex Emergency', reportingDate: '2025-07-31', roundNumber: 78, totalIdps: 89114,
      reasons: [],
      regions: [{ pcode: 'BI005', name: 'Cibitoke', idps: 24417 }],
      flows: [],
    },
  ],
  fetchedAt: 1785542400000,
  dataAvailable: true,
};

let panel: InstanceType<typeof DisplacementPanel>;

// Panel.setSafeContent commits on a 150 ms debounce.
const CONTENT_DEBOUNCE_MS = 150;
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS + 1);
}

function mount(): void {
  panel = new DisplacementPanel();
  document.body.appendChild(panel.getElement());
}

const rows = (): HTMLElement[] => Array.from(panel.getElement().querySelectorAll('.disp-row'));

beforeAll(async () => {
  await initTestI18n();
  expect(tt('components.displacement.internal')).toBe('Internal');
});

beforeEach(() => {
  document.body.replaceChildren();
  vi.useFakeTimers();
});

afterEach(() => {
  panel?.destroy();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('Internal tab', () => {
  it('shows DTM operations when UNHCR data never arrived', async () => {
    mount();
    panel.setInternalData(toInternalDisplacementData(RESPONSE));
    await flush();
    const tab = panel.getElement().querySelector<HTMLElement>('[data-tab="internal"]');
    expect(tab?.classList.contains('active')).toBe(true);
    expect(rows().map((row) => row.querySelector('.disp-name')?.firstChild?.textContent)).toEqual(['Sudan', 'Burundi']);
  });

  it('keeps DTM data when the UNHCR load fails afterwards', async () => {
    mount();
    panel.setInternalData(toInternalDisplacementData(RESPONSE));
    await flush();
    // DataLoaderManager.showColdLoadError: an error only replaces a panel holding no data.
    if (!panel.hasData()) panel.showError();
    await flush();
    expect(rows()).toHaveLength(2);
  });

  it('focuses the map on a placed operation and ignores an unplaced one', async () => {
    mount();
    const onClick = vi.fn();
    panel.setCountryClickHandler(onClick);
    panel.setInternalData(toInternalDisplacementData(RESPONSE));
    await flush();
    const [sudan, burundi] = rows();
    burundi!.click();
    expect(onClick).not.toHaveBeenCalled();
    sudan!.click();
    expect(onClick).toHaveBeenCalledWith(15.66, 35.87);
  });
});

describe('Cross-border tab', () => {
  const CROSS_BORDER = toCrossBorderData({
    situations: [
      {
        id: 'nigeria', name: 'Nigeria situation', origin: 'NG', asOf: '2026-08-31', accelerating: true,
        flows: [{ kind: 'outflow', label: 'Refugees from Nigeria', origin: 'NG', measure: 'stock', total: 472619, asOf: '2026-08-31',
          countries: [{ country: 'Niger', iso2: 'NE', individuals: 324219, date: '2026-08-31', location: { latitude: 17.6, longitude: 8.1 } }] }],
        trend: { measure: 'stock', points: [], latestDelta: 46171, latestDays: 31, accelerating: true },
      },
      {
        id: 'mediterranean', name: 'Mediterranean routes', origin: '', asOf: '2026-10-04', accelerating: false,
        flows: [{ kind: 'arrival', label: 'Sea and land arrivals', origin: '', measure: 'monthly', total: 78128, asOf: '2026-10-04',
          months: [{ month: '2026-10', individuals: 349 }, { month: '2026-09', individuals: 12033 }],
          countries: [{ country: 'Spain', iso2: 'ES', individuals: 24646, date: '2026-09-30' }] }],
      },
    ],
  });

  it('keeps annual freshness scoped to annual tabs through tab and health updates', async () => {
    const source = dataFreshness.getSource('unhcr')!;
    const before = structuredClone(source);
    try {
      dataFreshness.recordSeedHealth([{ sourceId: 'unhcr', status: 'OK', records: 212, seedAgeMin: 3, maxStaleMin: 3600, checkedAtMs: Date.now() }]);
      dataFreshness.setEnabled('unhcr', false);
      mount();
      panel.setData({ year: 2026, globalTotals: { refugees: 28500000, asylumSeekers: 9000000, idps: 64200000, stateless: 0, total: 106200000 }, countries: [], topFlows: [] });
      panel.setInternalData(toInternalDisplacementData(RESPONSE));
      panel.setCrossBorderData(CROSS_BORDER);
      await flush();
      const badge = panel.getElement().querySelector<HTMLElement>('.panel-freshness-badge')!;
      expect(badge.textContent).toBe('Disabled');
      expect(badge.style.display).toBe('inline-flex');
      for (const tab of ['crossBorder', 'internal']) {
        panel.getElement().querySelector<HTMLElement>(`[data-tab="${tab}"]`)!.click();
        await flush();
        expect(rows()).toHaveLength(2);
        expect(badge.style.display).toBe('none');
        dataFreshness.setEnabled('unhcr', true);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(badge.style.display).toBe('none');
      }
      panel.getElement().querySelector<HTMLElement>('[data-tab="hosts"]')!.click();
      await flush();
      expect(badge.style.display).toBe('inline-flex');
      expect(badge.textContent).toMatch(/^Fresh/);
    } finally {
      for (const key of Object.keys(source)) {
        if (!Object.hasOwn(before, key)) Reflect.deleteProperty(source, key);
      }
      Object.assign(source, before);
    }
    expect(source).toEqual(before);
  });

  it('lists situations with their latest change next to the DTM tab, without UNHCR data', async () => {
    mount();
    panel.setInternalData(toInternalDisplacementData(RESPONSE));
    panel.setCrossBorderData(CROSS_BORDER);
    await flush();
    const tabIds = Array.from(panel.getElement().querySelectorAll<HTMLElement>('.panel-tab')).map((tab) => tab.dataset.tab);
    expect(tabIds).toEqual(['internal', 'crossBorder']);
    panel.getElement().querySelector<HTMLElement>('[data-tab="crossBorder"]')!.click();
    await flush();
    const [nigeria, med] = rows().map((row) => Array.from(row.querySelectorAll('td')));
    expect(nigeria![0]!.textContent).toContain('Nigeria situation');
    expect(nigeria![0]!.querySelector('.disp-badge')?.textContent).toBe(tt('components.displacement.accelerating'));
    expect(nigeria![0]!.textContent).toContain('2026-08-31 · Niger');
    expect(nigeria![1]!.textContent).toContain(`+${formatPopulation(46171)}`);
    expect(nigeria![1]!.textContent).toContain(tt('components.displacement.inDays', { days: '31' }));
    expect(nigeria![2]!.textContent).toBe(formatPopulation(472619));
    expect(med![1]!.textContent).toContain(`+${formatPopulation(12033)}`);
    expect(med![1]!.textContent).toContain('2026-09');
    expect(med![2]!.textContent).toBe(formatPopulation(78128));
  });
});
