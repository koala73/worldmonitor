/**
 * UNHCR Displacement panel: Internal (IOM DTM), Cross-border and Recent (IDMC) tabs (#9014).
 *
 * The DTM tab must not depend on UNHCR: the two sources load independently, so
 * a UNHCR outage would otherwise hide DTM data the panel already holds. A row
 * with no placed region must not move the map to (0, 0).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { toInternalDisplacementData } from '@/services/displacement/internal';
import { toCrossBorderData } from '@/services/displacement/cross-border';
import { toDisplacementEventsData } from '@/services/displacement/idu-events';
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
        if (!Object.prototype.hasOwnProperty.call(before, key)) Reflect.deleteProperty(source, key);
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
    expect(med![1]!.textContent).toContain(formatPopulation(12033));
    expect(med![1]!.textContent).not.toContain('+');
    expect(med![1]!.textContent).toContain('2026-09');
    expect(med![2]!.textContent).toBe(formatPopulation(78128));
  });
});

describe('operational cross-border rows', () => {
  it('keeps an explicit zero, source/date, period windows and the measure on each row', async () => {
    mount();
    panel.setCrossBorderData({ situations: [{ id: 'uk', name: 'English Channel', source: 'UK Home Office', sourceUrl: 'https://www.gov.uk/', asOf: '2026-10-18', accelerating: false, outflow: 0, total: 0, lastMonth: null, latestChange: null, topCountries: [], countryCodes: ['GB'], kind: 'arrival', measure: 'daily', last7Days: 0, last30Days: 3455, changePct: 118.3 }], points: [], sources: [{ id: 'uk', name: 'UK Home Office', status: 'ok', fetchedAt: 1, contentAt: 1, maxContentAgeMin: 4320 }] });
    await flush();
    const row = rows()[0]!;
    expect(row.textContent).toContain('2026-10-18');
    expect(row.textContent).toContain('arrival');
    expect(row.textContent).toContain('daily');
    expect(row.querySelector('a')?.getAttribute('href')).toBe('https://www.gov.uk/');
    expect(row.querySelector('.disp-count')?.textContent).toBe('0');
    expect(row.querySelector('.disp-round')?.textContent).toContain('0 / 3,455');
    expect(row.textContent).toContain('+118%');
    expect(panel.getElement().textContent).toContain('UK Home Office: ok');
  });
});

describe('Recent tab (IDMC)', () => {
  const country = (countryCode: string, countryName: string, overrides: Record<string, unknown>) => ({
    countryCode, countryName, displaced30d: 0, conflict30d: 0, disaster30d: 0, events30d: 0,
    newlyReported7d: 0, latestDisplacementDate: '2026-10-01', baselineMonthly: 0, surge: false, ...overrides,
  });
  const EVENTS = toDisplacementEventsData({
    countries: [
      country('COD', 'DR Congo', { displaced30d: 57000, conflict30d: 57000, events30d: 4 }),
      country('PHL', 'Philippines', { displaced30d: 759032, conflict30d: 51276, disaster30d: 707756, events30d: 13, surge: true }),
      country('SDN', 'Sudan', {}),
    ],
    events: [
      { id: '1', countryCode: 'PHL', displacementType: 'Disaster', figure: 399403, displacementDate: '2026-09-25', createdAt: '2026-09-25',
        eventName: 'Philippines: Storm', hazardType: 'Storm', locationName: 'Calabarzon, Philippines', location: { latitude: 14.16, longitude: 121.35 } },
    ],
    windowFrom: '2026-04-24',
    missingCountries: [],
  });

  it('lists surging countries first with the conflict/disaster split, and leaves out quiet ones', async () => {
    mount();
    const onClick = vi.fn();
    panel.setCountryClickHandler(onClick);
    panel.setEventsData(EVENTS);
    await flush();
    expect(panel.getElement().querySelector<HTMLElement>('[data-tab="recent"]')?.classList.contains('active')).toBe(true);
    const [phl, cod, ...rest] = rows().map((row) => Array.from(row.querySelectorAll('td')));
    expect(rest).toHaveLength(0);
    expect(phl![0]!.firstChild?.textContent?.trim()).toBe('Philippines');
    expect(phl![0]!.querySelector('.disp-badge')?.textContent).toBe(tt('components.displacement.surge'));
    expect(phl![0]!.querySelector('.disp-operation')?.textContent).toBe(
      `${tt('components.displacement.conflict')} ${formatPopulation(51276)} · ${tt('components.displacement.disaster')} ${formatPopulation(707756)}`,
    );
    expect(phl![1]!.textContent).toBe('—');
    expect(phl![2]!.textContent).toBe(formatPopulation(759032));
    expect(cod![0]!.querySelector('.disp-badge')).toBeNull();
    expect(panel.getElement().querySelector('.disp-source-note')?.textContent).toContain(tt('components.displacement.recentNote'));
    rows()[1]!.click();
    expect(onClick).not.toHaveBeenCalled();
    rows()[0]!.click();
    expect(onClick).toHaveBeenCalledWith(14.16, 121.35);
  });

  it('counts IDMC countries when UNHCR never arrived, and names failed files and the data date', async () => {
    mount();
    panel.setEventsData(toDisplacementEventsData({
      countries: [country('PHL', 'Philippines', { displaced30d: 759032, surge: true })],
      events: [],
      windowFrom: '2026-04-24',
      missingCountries: ['AFG', 'YEM'],
    }));
    await flush();
    expect(panel.getElement().querySelector('.panel-count')?.textContent).toBe('1');
    const note = panel.getElement().querySelector('.disp-source-note')?.textContent ?? '';
    expect(note).toContain(tt('components.displacement.recentNote'));
    expect(note).toContain(tt('components.displacement.recentAsOf', { date: '2026-10-20' }));
    expect(note).toContain(tt('components.displacement.recentMissing', { countries: 'AFG, YEM' }));
  });

  it('keeps its tab when UNHCR data arrives later', async () => {
    mount();
    panel.setEventsData(EVENTS);
    panel.setData({ year: 2026, globalTotals: { refugees: 1, asylumSeekers: 0, idps: 0, stateless: 0, total: 1 }, countries: [], topFlows: [] });
    await flush();
    const tabIds = Array.from(panel.getElement().querySelectorAll<HTMLElement>('.panel-tab')).map((tab) => tab.dataset.tab);
    expect(tabIds).toEqual(['origins', 'hosts', 'recent']);
    panel.getElement().querySelector<HTMLElement>('[data-tab="recent"]')!.click();
    await flush();
    expect(rows()).toHaveLength(2);
  });
});
