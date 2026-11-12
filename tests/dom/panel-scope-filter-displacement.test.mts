/**
 * Dashboard focus (#10453), Displacement: UNHCR origin and host rows carry an
 * ISO3 code, IDMC (Recent) and IOM DTM (Internal) rows a country code, and
 * cross-border situations the ISO2 codes of the crisis and receiving
 * countries. Under a focus each tab lists chosen countries, then neighbours
 * marked, counts the rest, and narrows BEFORE its 30/40-row cut. The
 * "Followed only" chip works within the focus.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import type { CountryDisplacement, CrossBorderData, DisplacementEventsData, InternalDisplacementData, UnhcrSummary } from '@/services/displacement';
import type { ResolvedScope } from '@/services/tab-focus';
import { resolveScope } from '../../shared/tab-scope-resolve';

const follow = vi.hoisted(() => ({ active: false, codes: new Set<string>() }));
vi.mock('@/utils/followed-only-chip', () => ({
  renderFollowedOnlyChip: () => ({ html: '', attach: () => () => {}, isActive: () => follow.active }),
}));
vi.mock('@/services/followed-countries', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/followed-countries')>(),
  isFollowed: (code: string) => follow.codes.has(code),
}));

const { DisplacementPanel } = await import('@/components/DisplacementPanel');

beforeAll(async () => {
  await initTestI18n();
});

const scopeOf = (countries: string[], neighbours = true): ResolvedScope => {
  const scope = { countries, neighbours };
  return { scope, ...resolveScope(scope) };
};
// Sudan's neighbours include Chad and South Sudan.
const SUDAN = scopeOf(['SD']);

function country(code: string, name: string, refugees: number, hostTotal: number): CountryDisplacement {
  return {
    code, name, refugees, asylumSeekers: 0, idps: 0, stateless: 0, totalDisplaced: refugees,
    hostRefugees: hostTotal, hostAsylumSeekers: 0, hostTotal,
  };
}

function unhcr(countries: CountryDisplacement[]): UnhcrSummary {
  return {
    year: 2026,
    globalTotals: { refugees: 1, asylumSeekers: 1, idps: 1, stateless: 0, total: 3 },
    countries,
    topFlows: [],
  } as UnhcrSummary;
}

const UNHCR = unhcr([
  country('AFG', 'Afghanistan', 3_000_000, 0),
  country('SDN', 'Sudan', 2_000_000, 800_000),
  country('SSD', 'South Sudan', 1_500_000, 0),
  country('XXX', 'Unknown origin', 500_000, 0),
  country('TCD', 'Chad', 100_000, 1_200_000),
  country('DEU', 'Germany', 0, 1_000_000),
]);

const EVENTS: DisplacementEventsData = {
  countries: [
    { countryCode: 'FRA', countryName: 'France', displaced30d: 9000, conflict30d: 0, disaster30d: 9000, newlyReported7d: 0, surge: false },
    { countryCode: 'TCD', countryName: 'Chad', displaced30d: 5000, conflict30d: 5000, disaster30d: 0, newlyReported7d: 0, surge: false },
    { countryCode: 'SDN', countryName: 'Sudan', displaced30d: 4000, conflict30d: 4000, disaster30d: 0, newlyReported7d: 0, surge: false },
  ],
  points: [],
  missingCountries: [],
  asOf: '2026-11-01',
};

const INTERNAL = {
  operations: [
    { countryCode: 'BDI', countryName: 'Burundi', operation: 'Burundi Complex Emergency', reportingDate: '2025-07-31', totalIdps: 89114, topReason: '' },
    { countryCode: 'SSD', countryName: 'South Sudan', operation: 'South Sudan Crisis', reportingDate: '2026-07-31', totalIdps: 2_000_000, topReason: '' },
    { countryCode: 'SDN', countryName: 'Sudan', operation: 'Armed Clashes in Sudan', reportingDate: '2026-07-31', totalIdps: 8_622_801, topReason: '' },
  ],
  fetchedAt: 1,
  dataAvailable: true,
} as unknown as InternalDisplacementData;

function situation(id: string, name: string, countryCodes: string[]): CrossBorderData['situations'][number] {
  return {
    id, name, sourceUrl: '', asOf: '2026-10-01', accelerating: false, outflow: 1000, total: 1000,
    lastMonth: null, latestChange: null, topCountries: [], countryCodes,
  };
}

const CROSS_BORDER: CrossBorderData = {
  situations: [
    situation('nigeria', 'Nigeria situation', ['NG', 'NE']),
    situation('sudan', 'Sudan situation', ['SD', 'TD', 'EG']),
    situation('med', 'Mediterranean routes', []),
  ],
  points: [],
};

let panel: InstanceType<typeof DisplacementPanel>;

beforeEach(() => {
  vi.useFakeTimers();
  follow.active = false;
  follow.codes = new Set();
  panel = new DisplacementPanel();
  document.body.appendChild(panel.getElement());
});

afterEach(() => {
  panel.destroy();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const settle = () => vi.advanceTimersByTimeAsync(300);
const el = () => panel.getElement();
const names = () => [...el().querySelectorAll('.disp-row .disp-name')].map((n) => n.firstChild?.textContent);
const strip = () => el().querySelector<HTMLElement>('.panel-scope-strip');
const stripButton = (action: string) => strip()?.querySelector<HTMLButtonElement>(`button[data-scope-action="${action}"]`);
const rowFor = (name: string) => [...el().querySelectorAll('.disp-row')].find((n) => n.querySelector('.disp-name')?.firstChild?.textContent === name);
const count = () => el().querySelector('.panel-count')?.textContent;
async function openTab(tab: string): Promise<void> {
  el().querySelector<HTMLElement>(`[data-tab="${tab}"]`)!.click();
  await settle();
}

describe('DisplacementPanel under a focus', () => {
  it('hides worldwide totals while focused and restores them on Show all and clearing', async () => {
    panel.setData(UNHCR);
    await settle();
    expect(el().querySelectorAll('.disp-stat-box')).toHaveLength(4);
    panel.applyScope(SUDAN);
    await settle();
    expect(el().querySelector('.disp-stats-grid')).toBeNull();
    await openTab('hosts');
    expect(el().querySelector('.disp-stats-grid')).toBeNull();
    stripButton('show-all')!.click();
    await settle();
    expect(el().querySelectorAll('.disp-stat-box')).toHaveLength(4);
    panel.applyScope(null);
    await settle();
    expect(el().querySelectorAll('.disp-stat-box')).toHaveLength(4);
  });

  it('origins: chosen country, then neighbours marked; counts hidden and unresolvable codes', async () => {
    panel.setData(UNHCR);
    panel.applyScope(SUDAN);
    await settle();

    expect(names()).toEqual(['Sudan', 'South Sudan', 'Chad']);
    expect(rowFor('Chad')?.querySelector('.panel-scope-tag-neighbour')?.textContent).toBe('Neighbour: Chad');
    expect(rowFor('Sudan')?.querySelector('.panel-scope-tag')).toBeNull();
    expect(strip()?.textContent).toContain('1 hidden by focus');
    expect(strip()?.textContent).toContain('1 item with no country');
    expect(count()).toBe('3');

    stripButton('show-unattributed')!.click();
    await settle();
    expect(names()).toEqual(['Sudan', 'South Sudan', 'Chad', 'Unknown origin']);
    expect(rowFor('Unknown origin')?.querySelector('.panel-scope-tag-none')?.textContent).toBe('No country');
  });

  it('keeps the focus visible when the active tab has no source rows', async () => {
    panel.setData(unhcr([country('SDN', 'Sudan', 1000, 0)]));
    panel.applyScope(SUDAN);
    await settle();
    await openTab('hosts');
    expect(names()).toEqual([]);
    expect(count()).toBe('0');
    expect(el().querySelector('.disp-stats-grid')).toBeNull();
    expect(strip()?.hidden).toBe(false);
    expect(strip()?.textContent).toContain('Showing Sudan');
    expect(el().querySelector('.panel-empty')).toBeTruthy();
    panel.applyScope(null);
    await settle();
    expect(strip()?.hidden).toBe(true);
    expect(el().querySelectorAll('.disp-stat-box')).toHaveLength(4);
  });

  it('hosts: host countries count too', async () => {
    panel.setData(UNHCR);
    panel.applyScope(SUDAN);
    await settle();
    await openTab('hosts');
    expect(names()).toEqual(['Sudan', 'Chad']);
    expect(strip()?.textContent).toContain('1 hidden by focus');
  });

  it('Show all shows everything, Apply focus filters again, and clearing restores the full list and count', async () => {
    panel.setData(UNHCR);
    panel.applyScope(SUDAN);
    await settle();
    stripButton('show-all')!.click();
    await settle();
    expect(names()).toEqual(['Afghanistan', 'Sudan', 'South Sudan', 'Unknown origin', 'Chad']);
    expect(count()).toBe('6');
    stripButton('apply')!.click();
    await settle();
    expect(names()).toEqual(['Sudan', 'South Sudan', 'Chad']);
    panel.applyScope(null);
    await settle();
    expect(names()).toEqual(['Afghanistan', 'Sudan', 'South Sudan', 'Unknown origin', 'Chad']);
    expect(strip()?.hidden).toBe(true);
    expect(count()).toBe('6');
  });

  it('narrows before the 30-row cut, so a focused country beyond the top 30 is shown', async () => {
    const filler = ['USA', 'CAN', 'MEX', 'BRA', 'ARG', 'CHL', 'PER', 'COL', 'VEN', 'FRA', 'DEU', 'ITA', 'ESP', 'PRT', 'GBR', 'IRL', 'NOR', 'SWE', 'FIN', 'POL', 'UKR', 'RUS', 'TUR', 'IRN', 'IRQ', 'SYR', 'AFG', 'PAK', 'IND', 'JPN', 'KOR', 'AUS']
      .map((code, i) => country(code, code, 10_000_000 - i, 0));
    panel.setData(unhcr([...filler, country('SDN', 'Sudan', 1000, 0)]));
    await settle();
    expect(names()).not.toContain('Sudan');
    panel.applyScope(SUDAN);
    await settle();
    expect(names()).toEqual(['Sudan']);
    expect(strip()?.textContent).toContain('32 hidden by focus');
  });

  it('shows every row that matches the focus, even beyond the unfocused 30-row cut', async () => {
    const wide = scopeOf(['CN', 'RU', 'BR', 'IN', 'DE', 'FR', 'TR', 'IR', 'CD', 'SD', 'AR', 'PK']);
    const inScope = [...wide.chosen, ...wide.neighbours];
    expect(inScope.length).toBeGreaterThan(40);
    const iso3 = (await import('../../shared/iso2-to-iso3.json')).default as Record<string, string>;
    const rows = inScope.slice(0, 45).map((code, i) => country(iso3[code]!, `Country ${code}`, 9_000_000 - i, 0));
    panel.setData(unhcr(rows));
    await settle();
    expect(names().length).toBe(30);
    panel.applyScope(wide);
    await settle();
    expect(names().length).toBe(45);
    expect(strip()?.textContent).not.toContain('hidden by focus');
  });

  it('Recent (IDMC), Internal (DTM) and Cross-border tabs filter by their own codes', async () => {
    panel.setEventsData(EVENTS);
    panel.setInternalData(INTERNAL);
    panel.setCrossBorderData(CROSS_BORDER);
    panel.applyScope(SUDAN);
    await settle();

    expect(names()).toEqual(['Sudan', 'Chad']);
    expect(rowFor('Chad')?.querySelector('.panel-scope-tag-neighbour')).not.toBeNull();
    expect(strip()?.textContent).toContain('1 hidden by focus');

    await openTab('internal');
    expect(names()).toEqual(['Sudan', 'South Sudan']);
    expect(strip()?.textContent).toContain('1 hidden by focus');

    await openTab('crossBorder');
    // A situation counts when the crisis or any receiving country is chosen.
    expect(names()).toEqual(['Sudan situation']);
    expect(strip()?.textContent).toContain('1 hidden by focus');
    expect(strip()?.textContent).toContain('1 item with no country');
  });

  it('restores the header count when a focus clears with only DTM data loaded', async () => {
    panel.setInternalData(INTERNAL);
    await settle();
    expect(count()).toBe('0');
    panel.applyScope(SUDAN);
    await settle();
    expect(count()).toBe('2');
    panel.applyScope(null);
    await settle();
    expect(count()).toBe('0');
  });

  it('runs the Followed only chip within the focus', async () => {
    follow.codes = new Set(['TD', 'AF']);
    follow.active = true;
    panel.setData(UNHCR);
    panel.applyScope(SUDAN);
    await settle();
    expect(names()).toEqual(['Chad']);
  });

  it('applies a focus set before the data arrives', async () => {
    panel.applyScope(SUDAN);
    await settle();
    expect(strip()?.hidden).toBe(true);
    panel.setData(UNHCR);
    await settle();
    expect(names()).toEqual(['Sudan', 'South Sudan', 'Chad']);
  });

  it('an empty focused result is distinct from the panel empty and error states, with the counts reachable', async () => {
    panel.setData(UNHCR);
    panel.applyScope(scopeOf(['NZ'], false));
    await settle();
    expect(el().querySelector('.panel-scope-empty')?.textContent).toContain('No displacement data for these countries');
    expect(el().querySelector('.panel-empty')).toBeNull();
    expect(el().querySelector('.panel-error-state')).toBeNull();
    expect(strip()?.textContent).toContain('4 hidden by focus');
    stripButton('show-all')!.click();
    await settle();
    expect(names()).toHaveLength(5);
  });

  it('hides the strip while loading and after a load failure, and a focus change keeps the failure', async () => {
    expect(strip()?.hidden).toBe(true);
    panel.applyScope(SUDAN);
    panel.showError('Displacement failed');
    await settle();
    expect(strip()?.hidden).toBe(true);
    panel.setData(UNHCR);
    await settle();
    expect(strip()?.hidden).toBe(false);

    panel.showError('Displacement failed');
    expect(strip()?.hidden).toBe(true);
    panel.applyScope(scopeOf(['TD']));
    await settle();
    expect(el().querySelector('.panel-error-state')?.textContent).toContain('Displacement failed');
    expect(strip()?.hidden).toBe(true);

    panel.showLoading();
    expect(strip()?.hidden).toBe(true);
  });

  it('is unchanged when unfocused', async () => {
    panel.setData(UNHCR);
    await settle();
    expect(names()).toEqual(['Afghanistan', 'Sudan', 'South Sudan', 'Unknown origin', 'Chad']);
    expect(strip()?.hidden).toBe(true);
    expect(el().querySelector('.panel-scope-tag')).toBeNull();
    expect(count()).toBe('6');
  });
});
