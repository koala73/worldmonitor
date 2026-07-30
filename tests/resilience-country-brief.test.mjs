import assert from 'node:assert/strict';
import test from 'node:test';
import { createCountryDeepDivePanelHarness } from './helpers/country-deep-dive-panel-harness.mjs';

const sampleScore = {
  score: 42,
  trend: 'stable',
  lastUpdated: '2026-04-04T00:00:00.000Z',
  components: {
    unrest: 10,
    conflict: 20,
    security: 30,
    information: 40,
  },
};

const emptySignals = {
  criticalNews: 0,
  protests: 0,
  militaryFlights: 0,
  militaryVessels: 0,
  outages: 0,
  aisDisruptions: 0,
  satelliteFires: 0,
  radiationAnomalies: 0,
  temporalAnomalies: 0,
  cyberThreats: 0,
  earthquakes: 0,
  displacementOutflow: 0,
  climateStress: 0,
  conflictEvents: 0,
  activeStrikes: 0,
  travelAdvisories: 0,
  travelAdvisoryMaxLevel: null,
  orefSirens: 0,
  orefHistory24h: 0,
  aviationDisruptions: 0,
  gpsJammingHexes: 0,
};

const sampleEnergyProfile = {
  mixAvailable: false,
  mixYear: 2025,
  coalShare: 0,
  gasShare: 35,
  oilShare: 5,
  nuclearShare: 0,
  renewShare: 60,
  windShare: 20,
  solarShare: 10,
  hydroShare: 30,
  importShare: 15,
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
  emberFossilShare: 40,
  emberRenewShare: 60,
  emberNuclearShare: 0,
  emberCoalShare: 0,
  emberGasShare: 35,
  emberDemandTwh: 120,
  emberDataMonth: '2026-04',
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
};

async function waitForLazyWidget(harness) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const widget = harness.getPanelRoot()?.querySelector('.resilience-widget-stub');
    if (widget) return widget;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('expected lazy resilience widget to render');
}

async function waitForResilienceFallback(harness) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const slot = harness.getPanelRoot()?.querySelector('.resilience-widget');
    const fallback = slot?.querySelector('.cdp-empty');
    if (fallback) return { slot, fallback };
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('expected lazy resilience widget fallback to render');
}

async function waitForSentryFailure(harness) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (harness.getSentryBreadcrumbs().length > 0 && harness.getSentryExceptions().length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('expected resilience widget lazy-load failure telemetry');
}

test('country deep-dive panel mounts the resilience widget beside the score card', async () => {
  const harness = await createCountryDeepDivePanelHarness();
  try {
    const panel = harness.createPanel();
    panel.show('Norway', 'NO', sampleScore, emptySignals);
    const widget = await waitForLazyWidget(harness);

    const root = harness.getPanelRoot();
    const summaryGrid = root?.querySelector('.cdp-summary-grid');

    assert.ok(root, 'expected panel root to be created');
    assert.ok(summaryGrid, 'expected summary grid to render');
    assert.ok(summaryGrid?.querySelector('.cdp-score-card'), 'expected score card to render');
    assert.ok(widget, 'expected resilience widget to render');
    assert.equal(widget?.getAttribute('data-country-code'), 'NO');
    assert.equal(summaryGrid?.childElementCount, 2);
  } finally {
    harness.cleanup();
  }
});

test('country deep-dive panel renders fallback when the resilience widget chunk rejects', async () => {
  const harness = await createCountryDeepDivePanelHarness({ resilienceWidgetMode: 'import-reject' });
  try {
    const panel = harness.createPanel();
    panel.show('Norway', 'NO', sampleScore, emptySignals);
    const { slot, fallback } = await waitForResilienceFallback(harness);

    assert.equal(fallback.textContent, 'countryBrief.resilienceScoreUnavailable');
    assert.equal(slot.querySelector('.cdp-loading-inline'), null, 'fallback must replace loading state');
    assert.equal(harness.getWidgets().length, 0, 'chunk failure must not create a widget');
    await waitForSentryFailure(harness);
    assert.equal(harness.getSentryBreadcrumbs().length, 1);
    assert.equal(harness.getSentryExceptions().length, 1);
  } finally {
    harness.cleanup();
  }
});

test('country deep-dive panel renders fallback when the resilience widget success handler throws', async () => {
  const harness = await createCountryDeepDivePanelHarness({ resilienceWidgetMode: 'constructor-throw' });
  try {
    const panel = harness.createPanel();
    panel.show('Norway', 'NO', sampleScore, emptySignals);
    const { slot, fallback } = await waitForResilienceFallback(harness);

    assert.equal(fallback.textContent, 'countryBrief.resilienceScoreUnavailable');
    assert.equal(slot.querySelector('.cdp-loading-inline'), null, 'fallback must replace loading state');
    assert.equal(harness.getWidgets().length, 0, 'constructor failure must not retain a widget');
    await waitForSentryFailure(harness);
    assert.equal(harness.getSentryBreadcrumbs().length, 1);
    assert.equal(harness.getSentryExceptions().length, 1);
  } finally {
    harness.cleanup();
  }
});

test('country deep-dive panel destroys a constructed resilience widget when setup throws', async () => {
  const harness = await createCountryDeepDivePanelHarness({ resilienceWidgetMode: 'get-element-throw' });
  try {
    const panel = harness.createPanel();
    panel.show('Norway', 'NO', sampleScore, emptySignals);
    const { slot, fallback } = await waitForResilienceFallback(harness);
    const widget = harness.getWidgets().at(-1);

    assert.equal(fallback.textContent, 'countryBrief.resilienceScoreUnavailable');
    assert.equal(slot.querySelector('.cdp-loading-inline'), null, 'fallback must replace loading state');
    assert.ok(widget, 'post-construction failure should create a widget before setup throws');
    assert.equal(widget.destroyCount, 1, 'failed setup must not leave widget subscriptions live');
    await waitForSentryFailure(harness);
    assert.equal(harness.getSentryBreadcrumbs().length, 1);
    assert.equal(harness.getSentryExceptions().length, 1);
  } finally {
    harness.cleanup();
  }
});

test('country deep-dive panel destroys each resilience widget exactly once across state transitions', async () => {
  const harness = await createCountryDeepDivePanelHarness();
  try {
    const panel = harness.createPanel();

    panel.show('Norway', 'NO', sampleScore, emptySignals);
    await waitForLazyWidget(harness);
    const firstWidget = harness.getWidgets().at(-1);
    panel.showLoading();

    assert.ok(firstWidget, 'expected first widget instance');
    assert.equal(firstWidget.destroyCount, 1);
    assert.equal(harness.document.querySelectorAll('.resilience-widget-stub').length, 0);

    panel.show('Yemen', 'YE', sampleScore, emptySignals);
    await waitForLazyWidget(harness);
    const secondWidget = harness.getWidgets().at(-1);
    panel.showGeoError(() => {});

    assert.ok(secondWidget, 'expected second widget instance');
    assert.equal(secondWidget.destroyCount, 1);
    assert.equal(harness.document.querySelectorAll('.resilience-widget-stub').length, 0);

    panel.show('United States', 'US', sampleScore, emptySignals);
    await waitForLazyWidget(harness);
    const thirdWidget = harness.getWidgets().at(-1);
    panel.hide();

    assert.ok(thirdWidget, 'expected third widget instance');
    assert.equal(thirdWidget.destroyCount, 1, 'hide() must destroy widget subscriptions');
    // hide() keeps DOM intact (panel is visually hidden); DOM is cleared on next show()
    assert.equal(harness.document.querySelectorAll('.resilience-widget-stub').length, 1, 'hide() does not clear DOM');
  } finally {
    harness.cleanup();
  }
});

test('country deep-dive panel forwards pending energy mix to the lazy resilience widget', async () => {
  const harness = await createCountryDeepDivePanelHarness();
  try {
    const panel = harness.createPanel();

    panel.show('Norway', 'NO', sampleScore, emptySignals);
    panel.updateEnergyProfile(sampleEnergyProfile);
    await waitForLazyWidget(harness);

    const widget = harness.getWidgets().at(-1);
    assert.ok(widget, 'expected lazy widget instance');
    assert.equal(widget.energyMixData, sampleEnergyProfile);
  } finally {
    harness.cleanup();
  }
});
