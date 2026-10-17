import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import { briefSectionState } from '@/components/country-brief-presentation';
import type { CountryEnergyProfileData } from '@/components/CountryBriefPanel';
import { initTestI18n } from './helpers/i18n.mts';
const reads = vi.hoisted(() => ({ attempted: [] as string[] }));
vi.hoisted(() => { globalThis.fetch = async input => { reads.attempted.push(String(input)); throw new Error('Energy evidence fixtures forbid network reads'); }; });
beforeAll(async () => { await initTestI18n(); });
afterAll(() => { expect(reads.attempted).toEqual([]); });
function energyProfile(overrides: Partial<CountryEnergyProfileData> = {}): CountryEnergyProfileData {
  return {
    mixAvailable: false,
    mixYear: 2025,
    coalShare: 10,
    gasShare: 35,
    oilShare: 5,
    nuclearShare: 0,
    renewShare: 50,
    windShare: 20,
    solarShare: 10,
    hydroShare: 20,
    importShare: 0,
    importShareAvailable: false,
    importShareYear: 0,
    importShareSource: '',
    gasStorageAvailable: false,
    gasStorageFillPct: 0,
    gasStorageChange1d: 0,
    gasStorageTrend: '',
    gasStorageDate: '',
    electricityAvailable: false,
    electricityPriceMwh: 0,
    electricitySource: '',
    electricityDate: '',
    jodiOilAvailable: false,
    jodiOilDataMonth: '',
    gasolineDemandKbd: 0,
    gasolineImportsKbd: 0,
    dieselDemandKbd: 0,
    dieselImportsKbd: 0,
    jetDemandKbd: 0,
    jetImportsKbd: 0,
    lpgDemandKbd: 0,
    lpgImportsKbd: 0,
    crudeImportsKbd: 0,
    jodiGasAvailable: false,
    jodiGasDataMonth: '',
    gasTotalDemandTj: 0,
    gasLngImportsTj: 0,
    gasPipeImportsTj: 0,
    gasLngShare: 0,
    ieaStocksAvailable: false,
    ieaStocksDataMonth: '',
    ieaDaysOfCover: 0,
    ieaNetExporter: false,
    ieaBelowObligation: false,
    emberFossilShare: 0,
    emberRenewShare: 0,
    emberNuclearShare: 0,
    emberCoalShare: 0,
    emberGasShare: 0,
    emberDemandTwh: 0,
    emberDataMonth: '',
    emberAvailable: false,
    sprRegime: '',
    sprCapacityMb: 0,
    sprOperator: '',
    sprIeaMember: false,
    sprStockholdingModel: '',
    sprNote: '',
    sprSource: '',
    sprAsOf: '',
    sprAvailable: false,
    ...overrides,
  };
}

function fixture(hosted = false) {
  const panel = Object.create(CountryDeepDivePanel.prototype) as CountryDeepDivePanel;
  const body = document.createElement('div');
  const card = document.createElement('div');
  const atlas = document.createElement('div');
  atlas.textContent = 'Hosted Atlas observations';
  const sectionBody = hosted ? document.createElement('div') : body;
  if (hosted) {
    sectionBody.append(body, atlas);
    Reflect.set(panel, 'hostedAtlasBody', atlas);
  }
  card.append(sectionBody);
  Reflect.set(panel, 'sections', [{ id: 'energy', title: 'Energy', card, body: sectionBody }]);
  Reflect.set(panel, 'energyBody', body);
  Reflect.set(panel, 'renderAtlasExposure', () => {});
  Reflect.set(panel, 'renderShockScenarioWidget', () => document.createElement('div'));
  return { panel, body, atlas, section: { id: 'energy' as const, title: 'Energy', card, body: sectionBody } };
}
function oilCells(body: HTMLElement) {
  return [...body.querySelectorAll('tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent));
}
const oilPaths = ['gasoline.demandKbd', 'gasoline.importsKbd', 'diesel.demandKbd', 'diesel.importsKbd', 'jet.demandKbd', 'jet.importsKbd', 'lpg.demandKbd', 'lpg.importsKbd', 'crude.importsKbd'];
const missingSources = ['JODI oil data not supplied in this profile.', 'JODI gas data not supplied in this profile.', 'IEA oil stocks data not supplied in this profile.'];
const unavailableText = 'Energy data unavailable for this country.' + missingSources.join('');

it.each([true, false])('preserves supplied and changed IEA observation months for net-exporter=%s', ieaNetExporter => {
  const { panel, body } = fixture();
  const data = energyProfile({ ieaStocksAvailable: true, ieaNetExporter, ieaDaysOfCover: 85, ieaBelowObligation: true, ieaStocksDataMonth: '2026-05' });
  panel.updateEnergyProfile(data);
  expect(body.textContent).toContain('2026-05');
  expect(body.textContent).toContain(ieaNetExporter ? 'Net Exporter' : '85 days of cover');
  if (!ieaNetExporter) expect(body.textContent).toContain('Below 90-day obligation');
  panel.updateEnergyProfile({ ...data, ieaStocksDataMonth: '2026-04' });
  expect(body.textContent).toContain('2026-04');
  expect(body.textContent).not.toContain('2026-05');
});
it.each([true, false])('does not invent a missing IEA month for net-exporter=%s', ieaNetExporter => {
  const { panel, body } = fixture();
  panel.updateEnergyProfile(energyProfile({ ieaStocksAvailable: true, ieaNetExporter, ieaDaysOfCover: 85 }));
  expect(body.textContent).toContain('IEA');
  expect(body.textContent).not.toContain('2026');
  expect(body.textContent).not.toContain('latest');
});
it('preserves all observed oil zeros including crude imports', () => {
  const { panel, body } = fixture();
  panel.updateEnergyProfile(energyProfile({ jodiOilAvailable: true, jodiOilDataMonth: '2026-06', jodiOilObservedMeasurements: oilPaths }));
  expect(oilCells(body)).toEqual([
    ['Gasoline', '0 kbd', '0 kbd'], ['Diesel', '0 kbd', '0 kbd'],
    ['Jet fuel', '0 kbd', '0 kbd'], ['Liquefied petroleum gas', '0 kbd', '0 kbd'], ['Crude', '—', '0 kbd'],
  ]);
  expect(body.textContent).toContain('2026-06');
});
it.each([{ label: 'absent', paths: undefined }, { label: 'empty', paths: [] }])('keeps unknown oil zeros as dashes with $label metadata', ({ paths: jodiOilObservedMeasurements }) => {
  const { panel, body } = fixture();
  panel.updateEnergyProfile(energyProfile({ jodiOilAvailable: true, jodiOilObservedMeasurements }));
  expect(oilCells(body)).toEqual([['Gasoline', '—', '—'], ['Diesel', '—', '—'], ['Jet fuel', '—', '—'], ['Liquefied petroleum gas', '—', '—']]);
});
it('marks only the supplied observed zero and preserves positive precision', () => {
  const { panel, body } = fixture();
  panel.updateEnergyProfile(energyProfile({ jodiOilAvailable: true, gasolineDemandKbd: 694.6263, jetImportsKbd: 32.7773, crudeImportsKbd: 579.0363, jodiOilObservedMeasurements: ['lpg.demandKbd'] }));
  expect(oilCells(body)).toEqual([['Gasoline', '694.6263 kbd', '—'], ['Diesel', '—', '—'], ['Jet fuel', '—', '32.7773 kbd'], ['Liquefied petroleum gas', '0 kbd', '—'], ['Crude', '—', '579.0363 kbd']]);
});
it('does not render unavailable metrics even when periods and observation paths remain supplied', () => {
  const { panel, body } = fixture();
  panel.updateEnergyProfile(energyProfile({ jodiOilDataMonth: '2026-06', ieaStocksDataMonth: '2026-05', jodiOilObservedMeasurements: oilPaths }));
  expect(body.textContent).toBe(unavailableText);
  expect(body.firstElementChild?.classList.contains('cdp-empty')).toBe(true);
});
it('clears old months and observed zeros on a later unavailable update', () => {
  const { panel, body } = fixture();
  panel.updateEnergyProfile(energyProfile({ jodiOilAvailable: true, jodiOilDataMonth: '2026-06', jodiOilObservedMeasurements: oilPaths, ieaStocksAvailable: true, ieaNetExporter: true, ieaStocksDataMonth: '2026-05' }));
  panel.updateEnergyProfile(energyProfile());
  expect(body.textContent).toBe(unavailableText);
  expect(body.querySelectorAll('table')).toHaveLength(0);
  expect(body.textContent).not.toMatch(/2026-0[56]|0 kbd/);
});

it('preserves supplied Ember periods and identifies an absent observation month across updates', () => {
  const { panel, body } = fixture();
  for (const month of ['2026-07', '2026-06', '', '   ']) {
    panel.updateEnergyProfile(energyProfile({ emberAvailable: true, emberDataMonth: month, emberFossilShare: 53, emberRenewShare: 42, emberNuclearShare: 5, emberDemandTwh: 864.4 }));
    expect(body.querySelector('.cdp-subtitle')?.textContent).toBe(`Monthly Generation Mix (${month.trim() ? month : 'observation month not supplied'})`);
    expect(body.textContent).toContain('864.4 TWh');
    expect(body.textContent).not.toContain('latest');
    expect(body.querySelectorAll('.cdp-subtitle')).toHaveLength(1);
  }
  panel.updateEnergyProfile(energyProfile({ emberDataMonth: '2026-07' }));
  expect(body.textContent).not.toContain('Monthly Generation Mix');
});

it.each(['jodiOilAvailable', 'jodiGasAvailable', 'ieaStocksAvailable'] as const)('discloses each missing source independently when %s changes', flag => {
  const { panel, body, section } = fixture();
  const data = energyProfile({ mixAvailable: true, jodiOilDataMonth: '2026-06', gasolineDemandKbd: 694.6263, jodiGasDataMonth: '2026-04', gasTotalDemandTj: 6480000, ieaStocksDataMonth: '2026-05', ieaDaysOfCover: 85 });
  const index = ['jodiOilAvailable', 'jodiGasAvailable', 'ieaStocksAvailable'].indexOf(flag);
  const values = ['694.6263 kbd', '180 BCM/mo', '85 days of cover'];
  const periods = ['2026-06', '2026-04', '2026-05'];
  for (const available of [false, true, false]) {
    panel.updateEnergyProfile({ ...data, [flag]: available });
    for (const [i, note] of missingSources.entries()) {
      expect(body.textContent?.includes(note)).toBe(i !== index || !available);
    }
    expect(body.textContent?.includes(values[index]!)).toBe(available);
    expect(body.textContent?.includes(periods[index]!)).toBe(available);
    expect(briefSectionState(section)).toBe('ready');
    expect(body.querySelectorAll('p.cdp-economic-source')).toHaveLength(available ? 2 : 3);
    expect(body.querySelector('.cdp-empty, [data-brief-state="unavailable"]')).toBeNull();
  }
});

it('retains observations on failed refresh, replaces lock state, and recovers without changing hosted Atlas', () => {
  const { panel, body, section, atlas } = fixture(true);
  const data = energyProfile({ jodiOilAvailable: true, jodiOilDataMonth: '2026-06', jodiOilObservedMeasurements: oilPaths });
  panel.updateEnergyProfile(data);
  expect(body.textContent).toContain(missingSources[1]);
  expect(briefSectionState(section)).toBe('ready');
  for (let i = 0; i < 2; i++) panel.setSectionFailure('energy', 'unavailable', 'Refresh failed.');
  expect(body.textContent).toContain('2026-06');
  expect(body.textContent).toContain('0 kbd');
  expect(body.textContent).toContain('Previously loaded observations remain visible.');
  expect(body.querySelectorAll('.cdp-refresh-failure')).toHaveLength(1);
  panel.setSectionFailure('energy', 'locked', 'Energy requires access.');
  expect(briefSectionState(section)).toBe('locked');
  expect(body.textContent).not.toContain('2026-06');
  expect(body.textContent).not.toContain('not supplied in this profile');
  panel.updateEnergyProfile(energyProfile());
  expect(body.textContent).toBe(unavailableText);
  expect(body.firstElementChild?.classList.contains('cdp-empty')).toBe(true);
  expect(briefSectionState(section)).toBe('ready');
  panel.updateEnergyProfile({ ...data, jodiOilDataMonth: '2026-07', jodiGasAvailable: true, ieaStocksAvailable: true });
  expect(briefSectionState(section)).toBe('ready');
  expect(body.textContent).toContain('2026-07');
  expect(body.textContent).not.toContain('2026-06');
  expect(body.textContent).not.toContain('not supplied in this profile');
  expect(body.querySelector('.cdp-refresh-failure, .cdp-pro-locked')).toBeNull();
  expect(atlas.textContent).toBe('Hosted Atlas observations');
  expect(atlas.parentElement?.contains(body)).toBe(true);
});
