import { afterEach, describe, expect, it, vi } from 'vitest';

const resilienceState = vi.hoisted(() => ({
  response: null as unknown,
}));

vi.mock('@/services/auth-state', () => ({
  getAuthState: () => ({
    user: { id: 'pro-user', name: 'Pro User', email: 'pro@example.com', role: 'pro' },
    isPending: false,
  }),
  subscribeAuthState: () => () => {},
}));

vi.mock('@/services/panel-gating', () => ({
  PanelGateReason: {
    NONE: 'none',
    ANONYMOUS: 'anonymous',
    FREE_TIER: 'free_tier',
    PAYMENT_ON_HOLD: 'payment_on_hold',
    RENEWAL_PENDING: 'renewal_pending',
    RENEWAL_FAILED: 'renewal_failed',
    LAPSED: 'lapsed',
  },
  getPanelGateReason: () => 'none',
}));

vi.mock('@/services/resilience', () => ({
  getResilienceScore: async () => resilienceState.response,
}));

const { LOCKED_PREVIEW } = await import('@/components/resilience-widget-utils');
resilienceState.response = LOCKED_PREVIEW;
const { ResilienceWidget } = await import('@/components/ResilienceWidget');

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ResilienceWidget energy import dependency', () => {
  it('labels an unavailable zero import share as unavailable', async () => {
    const widget = new ResilienceWidget('US');
    document.body.appendChild(widget.getElement());

    await vi.waitFor(() => {
      expect(widget.getElement().querySelector('.resilience-widget__domain-row')).not.toBeNull();
    });

    widget.setEnergyMix({
      mixAvailable: true, mixYear: 2024, coalShare: 20, gasShare: 30, oilShare: 10,
      nuclearShare: 10, renewShare: 30, windShare: 12, solarShare: 10, hydroShare: 8,
      importShare: 0, importShareAvailable: false, importShareYear: 0,
      importShareSource: '', gasStorageAvailable: false, gasStorageFillPct: 0,
      gasStorageChange1d: 0, gasStorageTrend: '', gasStorageDate: '', electricityAvailable: false,
      electricityPriceMwh: 0, electricitySource: '', electricityDate: '',
      jodiOilAvailable: false, jodiOilDataMonth: '', gasolineDemandKbd: 0,
      gasolineImportsKbd: 0, dieselDemandKbd: 0, dieselImportsKbd: 0,
      jetDemandKbd: 0, jetImportsKbd: 0, lpgDemandKbd: 0, lpgImportsKbd: 0,
      crudeImportsKbd: 0, jodiGasAvailable: false, jodiGasDataMonth: '',
      gasTotalDemandTj: 0, gasLngImportsTj: 0, gasPipeImportsTj: 0,
      gasLngShare: 0, ieaStocksAvailable: false, ieaStocksDataMonth: '',
      ieaDaysOfCover: 0, ieaNetExporter: false, ieaBelowObligation: false,
      emberFossilShare: 0, emberRenewShare: 0, emberNuclearShare: 0,
      emberCoalShare: 0, emberGasShare: 0, emberDemandTwh: 0,
      emberDataMonth: '', emberAvailable: false, sprRegime: 'unknown',
      sprCapacityMb: 0, sprOperator: '', sprIeaMember: false,
      sprStockholdingModel: '', sprNote: '', sprSource: '', sprAsOf: '',
      sprAvailable: false,
    });

    const energyLabel = [...widget.getElement().querySelectorAll('.resilience-widget__domain-label')]
      .find((label) => label.textContent === 'Energy');
    const title = energyLabel?.closest('.resilience-widget__domain-row')?.getAttribute('title');

    expect(title).toContain('Import dep: unavailable');
    expect(title).not.toContain('Import dep: 0.0%');

    widget.destroy();
  });
});
