import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCountryDeepDivePanelHarness } from './helpers/country-deep-dive-panel-harness.mjs';

describe('CountryDeepDivePanel source provenance', () => {
  it('renders government, unreviewed, and reviewed-wire provenance without conflicting cues', async () => {
    const harness = await createCountryDeepDivePanelHarness({
      sourceProvenance: {
        'MIIT (China)': {
          tier: 1,
          type: 'gov',
          riskProfile: {
            risk: 'high',
            stateAffiliated: 'China',
            note: 'Chinese Ministry of Industry and Information Technology official feed',
          },
        },
        'Unlisted Outlet': {
          tier: 1,
          type: 'unknown',
          riskProfile: {
            risk: 'unknown',
            note: 'Provenance not yet reviewed — do not treat as independent journalism',
          },
        },
        Reuters: {
          tier: 1,
          type: 'wire',
          riskProfile: {
            risk: 'low',
            note: 'Wire service, strict editorial standards',
          },
        },
        Meduza: {
          tier: 2,
          type: 'mainstream',
          riskProfile: {
            risk: 'low',
            knownBiases: ['Anti-Kremlin'],
            note: 'Independent Russian exile outlet',
          },
        },
        CNA: {
          tier: 2,
          type: 'mainstream',
          riskProfile: {
            risk: 'low',
            stateAffiliated: 'Singapore',
            note: 'Mediacorp public broadcaster',
          },
        },
      },
    });

    try {
      const panel = harness.createPanel();
      panel.show('China', 'CN', null, {
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
      });
      panel.updateNews([
        {
          title: 'Official industrial policy update',
          source: 'MIIT (China)',
          link: 'https://example.com/miit',
          pubDate: '2026-07-24T12:00:00.000Z',
        },
        {
          title: 'Unreviewed breaking report',
          source: 'Unlisted Outlet',
          link: 'https://example.com/unreviewed',
          pubDate: '2026-07-24T11:00:00.000Z',
        },
        {
          title: 'Reviewed wire report',
          source: 'Reuters',
          link: 'https://example.com/reuters',
          pubDate: '2026-07-24T10:00:00.000Z',
        },
        {
          title: 'Reviewed exile outlet report',
          source: 'Meduza',
          link: 'https://example.com/meduza',
          pubDate: '2026-07-24T09:00:00.000Z',
        },
        {
          title: 'Reviewed state-owned broadcaster report',
          source: 'CNA',
          link: 'https://example.com/cna',
          pubDate: '2026-07-24T08:00:00.000Z',
        },
      ]);
      for (let attempt = 0; attempt < 25 && harness.getWidgets().length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.equal(harness.getWidgets().length, 1, 'expected the lazy widget load to settle before cleanup');

      const rows = [...harness.getPanelRoot().querySelectorAll('.cdp-news-item')];
      assert.equal(rows.length, 5);
      const rowBySource = (source) => rows.find((row) =>
        row.querySelector('.cdp-news-meta')?.textContent?.includes(source));

      const governmentRow = rowBySource('MIIT (China)');
      assert.ok(governmentRow);
      assert.equal(governmentRow.querySelector('.cdp-state-badge')?.textContent, 'Official Government Source: China');
      assert.doesNotMatch(governmentRow.querySelector('.cdp-state-badge')?.textContent ?? '', /State Media/);
      assert.equal(
        governmentRow.querySelector('.cdp-state-badge')?.getAttribute('title'),
        'Official government source: China. Perspective: none recorded. Chinese Ministry of Industry and Information Technology official feed.',
      );
      assert.doesNotMatch(governmentRow.querySelector('.cdp-state-badge')?.getAttribute('title') ?? '', /State-affiliated/);
      assert.equal(governmentRow.querySelector('.provenance-fact'), null, 'the badge already names the state');
      assert.match(governmentRow.querySelector('.cdp-tier-badge')?.getAttribute('title') ?? '', /Official Government Source/);
      assert.doesNotMatch(governmentRow.querySelector('.cdp-tier-badge')?.getAttribute('title') ?? '', /top wire/i);

      const unreviewedRow = rowBySource('Unlisted Outlet');
      assert.ok(unreviewedRow);
      assert.equal(unreviewedRow.querySelector('.cdp-state-badge')?.textContent, '? Unreviewed');
      assert.match(unreviewedRow.querySelector('.cdp-state-badge')?.getAttribute('title') ?? '', /not yet reviewed/i);
      assert.match(unreviewedRow.querySelector('.cdp-tier-badge')?.getAttribute('title') ?? '', /Source type not yet reviewed/);

      const wireRow = rowBySource('Reuters');
      assert.ok(wireRow);
      assert.equal(wireRow.querySelector('.cdp-state-badge'), null);
      assert.match(wireRow.querySelector('.cdp-tier-badge')?.getAttribute('title') ?? '', /Wire Service/);

      const labelledLowRow = rowBySource('Meduza');
      assert.ok(labelledLowRow);
      assert.equal(labelledLowRow.querySelector('.propaganda-badge'), null, 'reviewed low keeps no risk badge');
      const perspective = labelledLowRow.querySelector('.provenance-fact.perspective');
      assert.equal(perspective?.textContent, 'Anti-Kremlin');
      assert.match(perspective?.getAttribute('title') ?? '', /^Reviewed\. Perspective: Anti-Kremlin\. Independent Russian exile outlet\./);
      assert.match(perspective?.getAttribute('title') ?? '', /not judged neutral/);

      const affiliatedLowRow = rowBySource('CNA');
      assert.ok(affiliatedLowRow);
      assert.equal(affiliatedLowRow.querySelector('.propaganda-badge'), null, 'reviewed low keeps no risk badge');
      assert.equal(affiliatedLowRow.querySelector('.provenance-fact.state')?.textContent, 'State-affiliated: Singapore');
      assert.doesNotMatch(affiliatedLowRow.querySelector('.provenance-fact.state')?.getAttribute('title') ?? '', /independent/i);
    } finally {
      harness.cleanup();
    }
  });

  it('discloses configured facts provenance, conditional description and missing years across updates', async () => {
    const harness = await createCountryDeepDivePanelHarness({ premiumAccess: true });
    try {
      const panel = harness.createPanel();
      panel.show('China', 'CN', null, null);
      const section = harness.getPanelRoot().querySelector('#cdp-section-facts');
      const facts = {
        headOfState: 'Fixture office holder', headOfStateTitle: 'President',
        population: 1_400_000_000, capital: 'Beijing', areaSqKm: 9_600_000,
        languages: ['Mandarin'], currencies: ['CNY'],
        wikipediaSummary: 'Fixture country description.', wikipediaThumbnailUrl: '',
      };
      panel.updateCountryFacts(facts);
      assert.match(section.textContent, /1.4B/);
      assert.match(section.textContent, /Beijing/);
      assert.match(section.textContent, /Configured structured facts source: Wikidata/);
      assert.match(section.textContent, /Description: Wikipedia/);
      assert.match(section.textContent, /Reference years are not supplied/);
      assert.equal(section.querySelectorAll('.cdp-economic-source').length, 1);
      panel.updateCountryFacts(facts);
      assert.equal(section.querySelectorAll('.cdp-economic-source').length, 1, 'repeated facts replace source notes');
      for (const wikipediaSummary of ['', '   ']) {
        panel.updateCountryFacts({ ...facts, wikipediaSummary });
        assert.match(section.textContent, /Configured structured facts source: Wikidata/);
        assert.doesNotMatch(section.textContent, /Description: Wikipedia/);
      }
      panel.updateCountryFacts({
        ...facts, headOfState: '', headOfStateTitle: '', population: 0, capital: '',
        areaSqKm: 0, languages: [], currencies: [],
      });
      assert.match(section.textContent, /Fixture country description/);
      assert.match(section.textContent, /Configured structured facts source: Wikidata/);
      assert.match(section.textContent, /Description: Wikipedia/);
      assert.doesNotMatch(section.textContent, /Facts supplied by Wikidata|Source: Wikidata/);
      panel.updateCountryFacts({ ...facts, headOfState: '', population: 0, capital: '', wikipediaSummary: '' });
      assert.match(section.textContent, /countryBrief.noFacts/);
      assert.doesNotMatch(section.textContent, /Wikidata|Wikipedia|Reference years/);
    } finally {
      for (let attempt = 0; attempt < 25 && harness.getWidgets().length === 0; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      harness.cleanup();
    }
  });

  it('qualifies configured sanctions lists, merged counts and Active without converting unavailable to zero', async () => {
    const harness = await createCountryDeepDivePanelHarness({ premiumAccess: true });
    try {
      const panel = harness.createPanel();
      panel.show('China', 'CN', null, null);
      const section = harness.getPanelRoot().querySelector('#cdp-section-sanctions');
      panel.updateSanctionsPressure({ entryCount: 1396, sanctionsActive: true });
      assert.match(section.textContent, /1396/);
      assert.match(section.textContent, /Active/);
      assert.match(section.textContent, /Configured dataset sources: OFAC SDN and Consolidated lists; Global Affairs Canada consolidated sanctions/);
      assert.match(section.textContent, /merged records linked to this country/);
      assert.match(section.textContent, /Active means the count is greater than zero/);
      assert.match(section.textContent, /not a legal assessment/);
      assert.match(section.textContent, /Per-source contributions, coverage and publication dates are not supplied/);
      panel.updateSanctionsPressure({ entryCount: 0, sanctionsActive: false });
      const values = [...section.querySelectorAll('.cdp-pro-metric-value')].map(node => node.textContent);
      assert.deepEqual(values, ['0', 'None']);
      assert.equal(section.querySelectorAll('.cdp-economic-source').length, 1);
      assert.doesNotMatch(section.textContent, /1396|fresh|complete coverage/i);
      panel.updateSanctionsPressure(null);
      assert.match(section.textContent, /No sanctions data available/);
      assert.equal(section.querySelectorAll('.cdp-pro-metric-value').length, 0);
      assert.doesNotMatch(section.textContent, /OFAC|Active|Configured dataset/);
    } finally {
      for (let attempt = 0; attempt < 25 && harness.getWidgets().length === 0; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      harness.cleanup();
    }
  });

  it('preserves failure and lock transitions around populated source disclosures', async () => {
    const harness = await createCountryDeepDivePanelHarness({ premiumAccess: true });
    try {
      const panel = harness.createPanel();
      panel.show('China', 'CN', null, null);
      for (const { id, populate, source } of [
        { id: 'facts', source: 'Wikidata', populate: () => panel.updateCountryFacts({
          headOfState: '', headOfStateTitle: '', population: 0, capital: '', areaSqKm: 0,
          languages: [], currencies: [], wikipediaSummary: 'Description-only fallback.', wikipediaThumbnailUrl: '',
        }) },
        { id: 'sanctions', source: 'OFAC', populate: () => panel.updateSanctionsPressure({ entryCount: 1396, sanctionsActive: true }) },
      ]) {
        const section = harness.getPanelRoot().querySelector(`#cdp-section-${id}`);
        populate();
        panel.setSectionFailure(id, 'unavailable', 'Fixture source unavailable.');
        assert.match(section.textContent, new RegExp(source));
        assert.match(section.textContent, /Fixture source unavailable. Previously loaded observations remain visible/);
        panel.setSectionFailure(id, 'unavailable', 'Fixture source unavailable.');
        assert.equal(section.querySelectorAll('.cdp-refresh-failure').length, 1);
        assert.equal(section.querySelectorAll('.cdp-economic-source').length, 1);
        populate();
        assert.doesNotMatch(section.textContent, /Previously loaded observations/);
        assert.equal(section.querySelectorAll('.cdp-economic-source').length, 1);
        panel.setSectionFailure(id, 'locked', 'Fixture access required.');
        assert.match(section.textContent, /Fixture access required/);
        assert.doesNotMatch(section.textContent, new RegExp(source));
        assert.equal(section.querySelectorAll('.cdp-economic-source').length, 0);
        populate();
        assert.match(section.textContent, new RegExp(source));
        assert.doesNotMatch(section.textContent, /Fixture access required/);
      }
    } finally {
      for (let attempt = 0; attempt < 25 && harness.getWidgets().length === 0; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      harness.cleanup();
    }
  });

});
