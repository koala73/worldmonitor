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

test('country deep-dive panel mounts the resilience widget beside the score card', async () => {
  const harness = await createCountryDeepDivePanelHarness();
  try {
    const panel = harness.createPanel();
    panel.show('Norway', 'NO', sampleScore, emptySignals);

    const root = harness.getPanelRoot();
    const summaryGrid = root?.querySelector('.cdp-summary-grid');
    const widget = summaryGrid?.querySelector('.resilience-widget-stub');

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

test('country deep-dive panel destroys each resilience widget exactly once across state transitions', async () => {
  const harness = await createCountryDeepDivePanelHarness();
  try {
    const panel = harness.createPanel();

    panel.show('Norway', 'NO', sampleScore, emptySignals);
    const firstWidget = harness.getWidgets().at(-1);
    panel.showLoading();

    assert.ok(firstWidget, 'expected first widget instance');
    assert.equal(firstWidget.destroyCount, 1);
    assert.equal(harness.document.querySelectorAll('.resilience-widget-stub').length, 0);

    panel.show('Yemen', 'YE', sampleScore, emptySignals);
    const secondWidget = harness.getWidgets().at(-1);
    panel.showGeoError(() => {});

    assert.ok(secondWidget, 'expected second widget instance');
    assert.equal(secondWidget.destroyCount, 1);
    assert.equal(harness.document.querySelectorAll('.resilience-widget-stub').length, 0);

    panel.show('United States', 'US', sampleScore, emptySignals);
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

test('country deep-dive panel renders IMF-populated economic indicators and country facts fields', async () => {
  const harness = await createCountryDeepDivePanelHarness();
  try {
    const panel = harness.createPanel();
    panel.show('United States', 'US', sampleScore, emptySignals);

    panel.updateEconomicIndicators([
      { label: 'GDP Growth', value: '2.4%', trend: 'up', source: 'IMF WEO 2025' },
      { label: 'Unemployment', value: '4.1%', trend: 'up', source: 'IMF WEO 2025' },
      { label: 'Inflation', value: '3.2%', trend: 'up', source: 'IMF WEO 2025' },
    ]);

    panel.updateCountryFacts({
      headOfState: 'President',
      headOfStateTitle: 'Head of State',
      wikipediaSummary: 'United States overview.',
      wikipediaThumbnailUrl: '',
      population: 334_000_000,
      capital: 'Washington, D.C.',
      languages: ['English'],
      currencies: ['USD'],
      areaSqKm: 9_833_520,
      countryName: 'United States',
      nominalGdpPerCapitaUsd: 54_321,
      pppGdpPerCapitaUsd: 65_800,
      imfPopulationMillions: 334.2,
      imfDataYear: 2025,
    });

    const root = harness.getPanelRoot();
    assert.ok(root, 'expected panel root to be created');

    const economicLabels = Array.from(root.querySelectorAll('.cdp-economic-item'))
      .map((item) => item.querySelector('.cdp-economic-label')?.textContent?.trim())
      .filter(Boolean);
    assert.deepEqual(economicLabels, ['GDP Growth', 'Unemployment', 'Inflation']);

    const factsText = root.querySelector('.cdp-facts-grid')?.textContent ?? '';
    assert.match(factsText, /GDP \/ Capita \(Nominal\)/);
    assert.match(factsText, /\$54\.3K/);
    assert.match(factsText, /GDP \/ Capita \(PPP\)/);
    assert.match(factsText, /\$65\.8K/);
    assert.match(factsText, /Population \(IMF\)/);
    assert.match(factsText, /334\.2M/);
    assert.match(factsText, /IMF Data Year/);
    assert.match(factsText, /2025/);
  } finally {
    harness.cleanup();
  }
});
