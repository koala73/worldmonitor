import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
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

function fixture() {
  const panel = Object.create(CountryDeepDivePanel.prototype) as CountryDeepDivePanel;
  const body = document.createElement('div');
  Reflect.set(panel, 'energyBody', body);
  Reflect.set(panel, 'renderAtlasExposure', () => {});
  Reflect.set(panel, 'renderShockScenarioWidget', () => document.createElement('div'));
  return { panel, body };
}
function oilCells(body: HTMLElement) {
  return [...body.querySelectorAll('tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent));
}
const oilPaths = ['gasoline.demandKbd', 'gasoline.importsKbd', 'diesel.demandKbd', 'diesel.importsKbd', 'jet.demandKbd', 'jet.importsKbd', 'lpg.demandKbd', 'lpg.importsKbd', 'crude.importsKbd'];

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
  expect(body.textContent).toBe('Energy data unavailable for this country.');
});
it('clears old months and observed zeros on a later unavailable update', () => {
  const { panel, body } = fixture();
  panel.updateEnergyProfile(energyProfile({ jodiOilAvailable: true, jodiOilDataMonth: '2026-06', jodiOilObservedMeasurements: oilPaths, ieaStocksAvailable: true, ieaNetExporter: true, ieaStocksDataMonth: '2026-05' }));
  panel.updateEnergyProfile(energyProfile());
  expect(body.textContent).toBe('Energy data unavailable for this country.');
  expect(body.querySelectorAll('table')).toHaveLength(0);
});
