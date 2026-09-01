/**
 * The country deep-dive unavailable-state test stubs ResilienceWidget, so it
 * cannot catch a regression that paints the backward-compatible scalar 0 as
 * `Import dep: 0.0%`. Mount the real widget and exercise that title branch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CountryEnergyProfileData } from '@/components/CountryBriefPanel';
import { LOCKED_PREVIEW } from '@/components/resilience-widget-utils';

const { getResilienceScore } = vi.hoisted(() => ({
  getResilienceScore: vi.fn(),
}));

vi.mock('@/services/resilience', () => ({ getResilienceScore }));

vi.mock('@/services/auth-state', () => ({
  getAuthState: () => ({
    isPending: false,
    user: { id: 'pro-user', name: 'Pro', email: 'pro@example.com', role: 'pro' as const },
  }),
  subscribeAuthState: () => () => {},
}));

vi.mock('@/services/panel-gating', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/panel-gating')>();
  return {
    ...actual,
    hasPremiumAccess: () => true,
    getPanelGateReason: () => actual.PanelGateReason.NONE,
  };
});

import { ResilienceWidget } from '@/components/ResilienceWidget';

function energyProfile(overrides: Partial<CountryEnergyProfileData> = {}): CountryEnergyProfileData {
  return {
    mixAvailable: true,
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

function energyRow(root: HTMLElement): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>('.resilience-widget__domain-row')]
    .find((row) => row.querySelector('.resilience-widget__domain-label')?.textContent === 'Energy');
}

describe('ResilienceWidget energy row import-dependency title', () => {
  let widget: ResilienceWidget | null = null;

  afterEach(() => {
    widget?.destroy();
    widget = null;
    document.body.replaceChildren();
  });

  it('does not render the backward-compatible 0 scalar as Import dep: 0.0%', async () => {
    getResilienceScore.mockResolvedValue(LOCKED_PREVIEW);

    widget = new ResilienceWidget('MT');
    widget.setEnergyMix(energyProfile({
      mixAvailable: true,
      importShare: 0,
      importShareAvailable: false,
    }));
    document.body.append(widget.getElement());

    await vi.waitFor(() => {
      expect(energyRow(widget!.getElement())).toBeTruthy();
    });

    const title = energyRow(widget.getElement())?.getAttribute('title') ?? '';
    expect(title).toContain('Import dep: unavailable');
    expect(title).not.toContain('Import dep: 0.0%');
  });
});
