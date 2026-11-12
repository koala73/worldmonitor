import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import type { CountryEnergyProfileData } from '@/components/CountryBriefPanel';
import type { RegionalEnergyFeed, RegionalEnergyObservation } from '@/generated/client/worldmonitor/intelligence/v1/service_client';
import {
  formatRegionalPeriod,
  formatRegionalValue,
  regionalAreaLabel,
  regionalFeedTitle,
  regionalMetricLabel,
  regionalSeriesRows,
} from '@/components/regional-energy-presentation';
import { initTestI18n } from './helpers/i18n.mts';

const reads = vi.hoisted(() => ({ attempted: [] as string[] }));
vi.hoisted(() => { globalThis.fetch = async input => { reads.attempted.push(String(input)); throw new Error('Regional energy fixtures forbid network reads'); }; });
beforeAll(async () => { await initTestI18n(); });
afterAll(() => { expect(reads.attempted).toEqual([]); });

function point(metric: string, period: string, value: number, unit: string, area = '', stale = false): RegionalEnergyObservation {
  return { metric, period, value, unit, area, stale };
}

function feed(overrides: Partial<RegionalEnergyFeed> = {}): RegionalEnergyFeed {
  return {
    sourceId: 'mem',
    name: 'Guatemala MEM fuel prices',
    sourceUrl: 'https://mem.gob.gt/precios-combustibles/',
    licence: 'Data licence unconfirmed; robots content-signal ai-train=no, use=reference',
    status: 'available',
    fetchedAt: Date.parse('2026-11-01T12:00:00Z'),
    observedAt: Date.parse('2026-10-30T00:00:00Z'),
    dataUrls: ['https://mem.gob.gt/wp-content/uploads/2026/10/precios.xlsx'],
    observations: [
      point('fuel.retail_price', '2026-10-29', 32, 'GTQ/gal', 'Gasolina Regular; Guatemala City'),
      point('fuel.retail_price', '2026-10-30', 32.5, 'GTQ/gal', 'Gasolina Regular; Guatemala City'),
      point('fuel.retail_price', '2026-10-30', 42.69, 'GTQ/gal', 'Diésel; Guatemala City'),
    ],
    error: '',
    ...overrides,
  };
}

function profile(regionalEnergyFeeds: RegionalEnergyFeed[]): CountryEnergyProfileData {
  // Every *Available flag left undefined is falsy, so only the regional block can render.
  return { regionalEnergyFeeds } as unknown as CountryEnergyProfileData;
}

function fixture() {
  const panel = Object.create(CountryDeepDivePanel.prototype) as CountryDeepDivePanel;
  const body = document.createElement('div');
  Reflect.set(panel, 'energyBody', body);
  Reflect.set(panel, 'renderAtlasExposure', () => {});
  Reflect.set(panel, 'renderShockScenarioWidget', () => document.createElement('div'));
  return { panel, body };
}

function rows(body: HTMLElement) {
  return [...body.querySelectorAll('.cdp-regional-energy tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent));
}

describe('regional energy presentation', () => {
  it('turns metric codes into plain labels', () => {
    expect(regionalMetricLabel('generation.hydro')).toBe('Hydro generation');
    expect(regionalMetricLabel('generation.solar_pv')).toBe('Solar PV generation');
    expect(regionalMetricLabel('energy.wind')).toBe('Wind output');
    expect(regionalMetricLabel('fuel.retail_price')).toBe('Retail price');
    expect(regionalMetricLabel('imports.india')).toBe('Imports from India');
    expect(regionalMetricLabel('gas.lng_share_of_supply')).toBe('LNG share of gas supply');
    expect(regionalMetricLabel('price.day_ahead')).toBe('Day-ahead price');
    expect(regionalMetricLabel('storage.pumped_hydro')).toBe('Storage pumped hydro');
  });

  it('translates source-language areas and drops grid codes', () => {
    expect(regionalAreaLabel('Gasolina Regular; Guatemala City')).toBe('Regular gasoline, Guatemala City');
    expect(regionalAreaLabel('GASOLINA COMUM')).toBe('Regular gasoline');
    expect(regionalAreaLabel('Север - Юг')).toBe('North–South zone');
    expect(regionalAreaLabel('LPG 12 Kg Cylinder; LPG Schedule 1')).toBe('LPG 12 kg cylinder, Price zone 1');
    expect(regionalAreaLabel('Motor Spirit; Schedule 3')).toBe('Petrol, Price zone 3');
    expect(regionalAreaLabel('SADI')).toBe('');
    expect(regionalAreaLabel('Eskom; week starting')).toBe('Week starting');
    expect(regionalAreaLabel('evening peak; gas and diesel oil')).toBe('Evening peak, Gas and diesel oil');
  });

  it('names feeds in plain words and keeps the registry name as a fallback', () => {
    expect(regionalFeedTitle(feed())).toBe('Ministry of Energy and Mines, Guatemala');
    expect(regionalFeedTitle(feed({ sourceId: 'cammesa', name: 'CAMMESA SADI' }))).toBe('CAMMESA, Argentina grid operator');
    expect(regionalFeedTitle(feed({ sourceId: 'future', name: 'Future feed' }))).toBe('Future feed');
  });

  it('formats values with readable units', () => {
    expect(formatRegionalValue(995.6, 'mln kWh')).toBe('995.6 million kWh');
    expect(formatRegionalValue(12900, 'MW')).toBe('12,900 MW');
    expect(formatRegionalValue(54255.93, 'MW')).toBe('54,256 MW');
    expect(formatRegionalValue(247.35, 'MW')).toBe('247.4 MW');
    expect(formatRegionalValue(-200, 'MW', true)).toBe('-200 MW');
    expect(formatRegionalValue(12.5, 'MW', true)).toBe('+12.5 MW');
    expect(formatRegionalValue(32.4, 'GTQ/gal')).toBe('32.40 GTQ per gallon');
    expect(formatRegionalValue(3.7, 'FJD/l')).toBe('3.70 FJD per litre');
    expect(formatRegionalValue(58, 'FJD/12kg')).toBe('58.00 FJD per 12 kg');
    expect(formatRegionalValue(1234567, 'm3')).toBe('1,234,567 m³');
    expect(formatRegionalValue(41.5, '%')).toBe('41.5%');
    expect(formatRegionalValue(2950, 'MMcfd')).toBe('2,950 million cubic feet per day');
    expect(formatRegionalValue(49.98, 'Hz')).toBe('49.98 Hz');
  });

  it('formats dates, months and timestamps', () => {
    expect(formatRegionalPeriod('2026-10-30')).toBe('30 Oct 2026');
    expect(formatRegionalPeriod('2026-09')).toBe('Sep 2026');
    expect(formatRegionalPeriod('2026-11-01T13:10:00.000Z')).toBe('1 Nov 2026, 13:10 UTC');
    expect(formatRegionalPeriod('not a date')).toBe('not a date');
  });

  it('builds one row per series with the latest value and the change since the previous reading', () => {
    const result = regionalSeriesRows(feed({
      observations: [
        point('demand', '2026-11-01T13:05:00.000Z', 12887, 'MW', 'SADI'),
        point('demand', '2026-11-01T13:10:00.000Z', 12900, 'MW', 'SADI'),
        point('exchange.net', '2026-11-01T13:05:00.000Z', 120, 'MW', 'SIN'),
        point('exchange.net', '2026-11-01T13:10:00.000Z', -80, 'MW', 'SIN', true),
        point('generation.wind', '2026-11-01T13:10:00.000Z', 0, 'MW'),
      ],
    }));
    expect(result).toEqual([
      { label: 'Demand', detail: '', latest: '12,900 MW', change: '+0.1%', changeTitle: 'Compared with 1 Nov 2026, 13:05 UTC', direction: 'up', period: '1 Nov 2026, 13:10 UTC', stale: false },
      { label: 'Net exchange', detail: '', latest: '-80 MW', change: '-200 MW', changeTitle: 'Compared with 1 Nov 2026, 13:05 UTC', direction: 'down', period: '1 Nov 2026, 13:10 UTC', stale: true },
      { label: 'Wind generation', detail: '', latest: '0 MW', change: '—', changeTitle: '', direction: 'none', period: '1 Nov 2026, 13:10 UTC', stale: false },
    ]);
  });

  it('leads fuel rows with the product, since the metric is the same on every row', () => {
    const result = regionalSeriesRows(feed({
      observations: [
        point('fuel.retail_price', '2026-10-30', 32.5, 'GTQ/gal', 'Gasolina Regular; Guatemala City'),
        point('fuel.exports', '2026-09', 1200, 'm3', 'ASFALTO'),
        point('fuel.subsidy', '2026-10-30', 0.4, 'PGK/l', 'Diesel; Port Moresby; Direct subsidy'),
      ],
    }));
    expect(result.map(row => [row.label, row.detail])).toEqual([
      ['Regular gasoline', 'Retail price, Guatemala City'],
      ['Asphalt', 'Exports'],
      ['Diesel', 'Subsidy, Port Moresby, Direct subsidy'],
    ]);
  });
});

describe('country deep-dive regional energy block', () => {
  it('renders a country whose only energy data is a regional feed', () => {
    const { panel, body } = fixture();
    panel.updateEnergyProfile(profile([feed()]));
    expect(body.textContent).not.toContain('Energy data unavailable for this country.');
    const block = body.querySelector('.cdp-regional-energy');
    expect(block?.querySelector('.cdp-subtitle')?.textContent).toBe('National energy data');
    expect(block?.querySelector('summary')?.textContent).toContain('Ministry of Energy and Mines, Guatemala');
    expect(block?.querySelector('summary')?.textContent).toContain('30 Oct 2026');
    // Every series shares one date, so the summary carries it and the table drops the column.
    expect([...block!.querySelectorAll('th')].map(th => th.textContent)).toEqual(['Series', 'Latest', 'Change']);
    expect(rows(body)).toEqual([
      ['Regular gasolineRetail price, Guatemala City', '32.50 GTQ per gallon', '+1.6%'],
      ['DieselRetail price, Guatemala City', '42.69 GTQ per gallon', '—'],
    ]);
    const link = block?.querySelector<HTMLAnchorElement>('.cdp-economic-source a');
    expect(link?.href).toBe('https://mem.gob.gt/precios-combustibles/');
    expect(link?.rel).toContain('noopener');
    expect(block?.textContent).not.toContain('robots');
  });

  it('keeps the empty state when every regional feed is unavailable', () => {
    const { panel, body } = fixture();
    panel.updateEnergyProfile(profile([feed({ status: 'unavailable', observations: [], observedAt: 0 })]));
    expect(body.textContent).toContain('Energy data unavailable for this country.');
    expect(body.querySelector('.cdp-regional-energy')).toBeNull();
  });

  it('keeps the empty state for profiles without the regional field', () => {
    const { panel, body } = fixture();
    panel.updateEnergyProfile({} as CountryEnergyProfileData);
    expect(body.textContent).toContain('Energy data unavailable for this country.');
  });

  it('says when a feed could not be read or has not updated recently', () => {
    const { panel, body } = fixture();
    panel.updateEnergyProfile(profile([
      feed({ sourceId: 'ons', name: 'Brazil ONS', status: 'error', error: 'invalid_cache_record', observations: [], observedAt: 0 }),
      feed({ sourceId: 'anp', name: 'Brazil ANP', status: 'stale', observations: [point('fuel.retail_price', '2026-09-20', 6.49, 'BRL/l', 'GASOLINA COMUM', true)] }),
    ]));
    const blocks = [...body.querySelectorAll('.cdp-regional-energy details')];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.textContent).toContain('Latest reading could not be loaded');
    expect(blocks[0]?.querySelector('table')).toBeNull();
    expect(blocks[0]?.textContent).not.toContain('invalid_cache_record');
    expect(blocks[1]?.textContent).toContain('Not updated recently');
    expect(blocks[1]?.querySelector('tbody tr')?.classList.contains('cdp-regional-energy-stale')).toBe(true);
    expect(rows(body)).toEqual([['Regular gasolineRetail price', '6.49 BRL per litre', '—', '20 Sep 2026 · not recent']]);
  });

  it('shows the error note when a failed feed is the only energy data', () => {
    const { panel, body } = fixture();
    panel.updateEnergyProfile(profile([feed({ status: 'error', error: 'cache_read_failed', observations: [], observedAt: 0 })]));
    expect(body.textContent).not.toContain('Energy data unavailable for this country.');
    expect(body.querySelector('.cdp-regional-energy summary')?.textContent).toContain('Latest reading could not be loaded');
  });

  it('keeps the date column when series report different dates', () => {
    const { panel, body } = fixture();
    panel.updateEnergyProfile(profile([feed({
      sourceId: 'anp',
      observations: [
        point('fuel.retail_price', '2026-10-24', 6.49, 'BRL/l', 'GASOLINA COMUM'),
        point('fuel.exports', '2026-09', 1200, 'm3', 'ASFALTO'),
      ],
    })]));
    expect([...body.querySelectorAll('.cdp-regional-energy th')].map(th => th.textContent)).toEqual(['Series', 'Latest', 'Change', 'Date']);
    expect(rows(body).map(row => row[3])).toEqual(['24 Oct 2026', 'Sep 2026']);
  });

  it('opens short feeds and collapses long ones', () => {
    const { panel, body } = fixture();
    const many = Array.from({ length: 12 }, (_, i) => point(`generation.unit_${i}`, '2026-10-31', i, 'MW'));
    panel.updateEnergyProfile(profile([feed(), feed({ sourceId: 'evn', name: 'Vietnam EVN system bulletin', observations: many })]));
    const blocks = [...body.querySelectorAll<HTMLDetailsElement>('.cdp-regional-energy details')];
    expect(blocks.map(block => block.open)).toEqual([true, false]);
    expect(blocks[1]?.querySelector('summary')?.textContent).toContain('12 series');
  });

  it('places the block after the other energy sections and before the source notes', () => {
    const { panel, body } = fixture();
    panel.updateEnergyProfile({ ...profile([feed()]), emberAvailable: true, emberDataMonth: '2026-09', emberRenewShare: 40, emberFossilShare: 60 });
    const text = body.textContent ?? '';
    expect(text.indexOf('Monthly Generation Mix')).toBeLessThan(text.indexOf('National energy data'));
    expect(text.indexOf('National energy data')).toBeLessThan(text.indexOf('JODI oil data not supplied'));
  });
});
