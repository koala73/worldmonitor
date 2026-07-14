import assert from 'node:assert/strict';
import test from 'node:test';
import { createCountryDeepDivePanelHarness } from './helpers/country-deep-dive-panel-harness.mjs';

const emptySignals = {
  criticalNews: 0,
  protests: 0,
  militaryFlights: 0,
  militaryVessels: 0,
  militaryFlightsInCountry: 0,
  militaryVesselsInCountry: 0,
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
  orefSirens: 0,
  orefHistory24h: 0,
  aviationDisruptions: 0,
  travelAdvisories: 0,
  travelAdvisoryMaxLevel: null,
  gpsJammingHexes: 0,
  isTier1: true,
  thermalEscalations: 0,
  sanctionsDesignations: 0,
  sanctionsNewDesignations: 0,
};

const summary = {
  groups: [
    {
      id: 'macro-policy',
      state: 'partial',
      signals: [{
        label: 'Consumer prices',
        value: '0.7%',
        source: 'OECD <img src=x>',
        observedAt: '2026-06',
        stale: false,
      }],
      unavailableReason: 'One policy source is temporarily unavailable.',
    },
    {
      id: 'market-credit',
      state: 'available',
      signals: [{
        label: 'Shanghai Composite',
        value: '3,420 CNY',
        source: 'Market Service',
        observedAt: '2026-07-14',
        stale: false,
      }],
    },
    {
      id: 'trade-supply',
      state: 'stale',
      signals: [{
        label: 'CCFI',
        value: '1,072',
        source: 'Shanghai Shipping Exchange',
        observedAt: '2026-07-11',
        stale: true,
      }],
    },
    {
      id: 'energy',
      state: 'available',
      signals: [{
        label: 'Oil product supply',
        value: 'Available',
        source: 'JODI',
        observedAt: '2026-05',
        stale: false,
      }],
    },
    {
      id: 'availability',
      state: 'available',
      signals: [{
        label: 'Aviation availability',
        value: '3 aircraft tracked',
        source: 'Country intelligence',
        stale: false,
      }],
    },
  ],
};

async function waitForResilienceWidget(harness: Awaited<ReturnType<typeof createCountryDeepDivePanelHarness>>): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (harness.getPanelRoot()?.querySelector('.resilience-widget-stub')) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test('China summary is scoped to China, exposes per-group states, and safely attributes sources', async () => {
  const harness = await createCountryDeepDivePanelHarness();
  try {
    const panel = harness.createPanel();
    panel.show('China', 'CN', null, emptySignals);
    await waitForResilienceWidget(harness);

    const card = harness.getPanelRoot()?.querySelector<HTMLElement>('.cdp-china-summary');
    assert.ok(card, 'China should receive the dedicated country summary');
    assert.equal(card?.getAttribute('aria-label'), 'countryBrief.china.title');
    assert.equal(card?.querySelectorAll('.cdp-china-summary-group').length, 5);
    assert.equal(card?.querySelector('[role="status"]')?.getAttribute('aria-live'), 'polite');
    assert.match(card?.textContent ?? '', /countryBrief\.china\.status\.loading/, 'groups start in an explicit loading state');

    const sectionsBeforeUpdate = Array.from(card?.querySelectorAll<HTMLElement>('.cdp-china-summary-group') ?? []);
    panel.updateChinaCountrySummary(summary);
    const sectionsAfterUpdate = Array.from(card?.querySelectorAll<HTMLElement>('.cdp-china-summary-group') ?? []);
    assert.equal(sectionsAfterUpdate.length, 5);
    for (let i = 0; i < sectionsBeforeUpdate.length; i += 1) {
      assert.equal(
        sectionsAfterUpdate[i],
        sectionsBeforeUpdate[i],
        'live-region sections persist across updates so state changes are announced',
      );
    }

    assert.match(card?.textContent ?? '', /countryBrief\.china\.status\.partial/);
    assert.match(card?.textContent ?? '', /countryBrief\.china\.status\.stale/);
    assert.match(
      card?.textContent ?? '',
      /One policy source is temporarily unavailable\./,
      'a partial group surfaces its degradation reason',
    );
    assert.match(card?.textContent ?? '', /OECD <img src=x>/, 'source attribution is retained as text');
    assert.equal(card?.querySelector('img'), null, 'source attribution is never interpreted as markup');
    const availability = Array.from(card?.querySelectorAll<HTMLElement>('.cdp-china-summary-group') ?? []).at(-1);
    assert.doesNotMatch(
      availability?.textContent ?? '',
      /countryBrief\.china\.observed|undefined/,
      'signals without a source timestamp do not display a fabricated observation time',
    );

    const unavailableSummary = {
      groups: summary.groups.map((group) => (group.id === 'energy'
        ? { id: group.id, state: 'unavailable', signals: [], unavailableReason: 'Energy data are currently unavailable.' }
        : group)),
    };
    panel.updateChinaCountrySummary(unavailableSummary);
    const unavailableGroup = card?.querySelector<HTMLElement>('.cdp-china-summary-group--unavailable');
    assert.ok(unavailableGroup, 'an empty group renders the explicit unavailable state');
    assert.match(unavailableGroup?.textContent ?? '', /countryBrief\.china\.status\.unavailable/);
    assert.match(
      unavailableGroup?.textContent ?? '',
      /Energy data are currently unavailable\./,
      'an unavailable group surfaces its outage reason instead of a blank card',
    );

    panel.show('Japan', 'JP', null, emptySignals);
    await waitForResilienceWidget(harness);
    assert.equal(harness.getPanelRoot()?.querySelector('.cdp-china-summary'), null, 'the summary clears when the country changes');

    panel.updateChinaCountrySummary(summary);
    assert.equal(
      harness.getPanelRoot()?.querySelector('.cdp-china-summary'),
      null,
      'a late China update while another country is displayed is dropped by the panel guard',
    );

    panel.show('China', 'cn', null, emptySignals);
    await waitForResilienceWidget(harness);
    panel.updateChinaCountrySummary(summary);
    assert.match(
      harness.getPanelRoot()?.querySelector('.cdp-china-summary')?.textContent ?? '',
      /countryBrief\.china\.status\.partial/,
      'country-code casing does not strand the summary in its loading state',
    );
  } finally {
    harness.cleanup();
  }
});
