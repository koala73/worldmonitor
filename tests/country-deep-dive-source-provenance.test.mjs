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
      ]);
      for (let attempt = 0; attempt < 25 && harness.getWidgets().length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.equal(harness.getWidgets().length, 1, 'expected the lazy widget load to settle before cleanup');

      const rows = [...harness.getPanelRoot().querySelectorAll('.cdp-news-item')];
      assert.equal(rows.length, 3);
      const rowBySource = (source) => rows.find((row) =>
        row.querySelector('.cdp-news-meta')?.textContent?.includes(source));

      const governmentRow = rowBySource('MIIT (China)');
      assert.ok(governmentRow);
      assert.match(governmentRow.querySelector('.cdp-state-badge')?.textContent ?? '', /State Media: China/);
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
    } finally {
      harness.cleanup();
    }
  });
});
