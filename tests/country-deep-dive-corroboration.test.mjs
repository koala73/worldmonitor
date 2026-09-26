import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCountryDeepDivePanelHarness } from './helpers/country-deep-dive-panel-harness.mjs';

const EMPTY_SIGNALS = {
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

const headline = (title, source, pubDate) => ({
  title,
  source,
  link: `https://example.com/${encodeURIComponent(title)}/${encodeURIComponent(source)}`,
  pubDate,
});

async function renderRows(headlines, sourceProvenance) {
  const harness = await createCountryDeepDivePanelHarness({ sourceProvenance });
  try {
    const panel = harness.createPanel();
    panel.show('China', 'CN', null, EMPTY_SIGNALS);
    panel.updateNews(headlines);
    for (let attempt = 0; attempt < 25 && harness.getWidgets().length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return [...harness.getPanelRoot().querySelectorAll('.cdp-news-entry')].map((entry) => ({
      meta: entry.querySelector('.cdp-news-meta')?.textContent ?? '',
      metaTitle: entry.querySelector('.cdp-news-meta')?.getAttribute('title') ?? null,
      flag: entry.querySelector('.corroboration-flag')?.textContent ?? null,
      flagHint: entry.querySelector('.corroboration-flag')?.getAttribute('title') ?? null,
      tierBadge: entry.querySelector('.cdp-tier-badge')?.textContent ?? null,
      roster: entry.querySelector('summary')?.textContent ?? null,
      publishers: entry.querySelectorAll('.publisher-name').map((name) => name.textContent),
    }));
  } finally {
    harness.cleanup();
  }
}

describe('CountryDeepDivePanel corroboration (#6428, #6419)', () => {
  it('lists publisher families, not feed labels, in the roster', async () => {
    const rows = await renderRows([
      headline('Border ceasefire talks resume in Geneva after strikes', 'Reuters World', '2026-09-20T12:00:00.000Z'),
      headline('Border ceasefire talks resume in Geneva after strikes', 'Reuters US', '2026-09-20T11:00:00.000Z'),
      headline('Border ceasefire talks resume in Geneva after strikes', 'Reuters Business', '2026-09-20T10:00:00.000Z'),
      headline('Grain export corridor reopens through Black Sea ports', 'Reuters World', '2026-09-20T09:00:00.000Z'),
      headline('Grain export corridor reopens through Black Sea ports', 'BBC World', '2026-09-20T08:00:00.000Z'),
    ], {
      'Reuters World': { tier: 1, type: 'wire', riskProfile: { risk: 'low', note: 'Wire' } },
      'Reuters US': { tier: 1, type: 'wire', riskProfile: { risk: 'low', note: 'Wire' } },
      'Reuters Business': { tier: 1, type: 'wire', riskProfile: { risk: 'low', note: 'Wire' } },
      'BBC World': { tier: 2, type: 'mainstream', riskProfile: { risk: 'low', note: 'Broadcaster' } },
    });

    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.match(row.meta, /^Reuters World •/, 'the meta line no longer carries "+N sources"');
      assert.equal(row.metaTitle, null, 'the "Also reported by" tooltip is replaced by the roster');
    }
    const reutersOnly = rows.find((row) => row.flag !== null);
    assert.ok(reutersOnly, `expected a one-publisher row, got ${JSON.stringify(rows)}`);
    assert.equal(reutersOnly.flag, 'components.corroboration.singlePublisher');
    assert.equal(reutersOnly.flagHint, 'components.corroboration.singlePublisherHint');
    assert.equal(reutersOnly.roster, null, 'the pill already names the only publisher');

    const twoPublishers = rows.find((row) => row !== reutersOnly);
    assert.equal(twoPublishers.flag, null);
    assert.equal(twoPublishers.roster, 'components.corroboration.rosterSummaryTier1');
    assert.deepEqual(twoPublishers.publishers, ['Reuters', 'BBC']);
  });

  it('takes the largest digest publisher count across the group, not only the primary', async () => {
    const rows = await renderRows([
      { ...headline('Central bank signals emergency rate cut', 'Reuters World', '2026-09-20T12:00:00.000Z'), corroborationCount: 1 },
      { ...headline('Central bank signals emergency rate cut', 'Reuters US', '2026-09-20T11:00:00.000Z'), corroborationCount: 3 },
    ], {
      'Reuters World': { tier: 1, type: 'wire', riskProfile: { risk: 'low', note: 'Wire' } },
      'Reuters US': { tier: 1, type: 'wire', riskProfile: { risk: 'low', note: 'Wire' } },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].flag, null, 'a sibling seen by three publishers is not single-publisher');
    assert.deepEqual(rows[0].publishers, ['Reuters'], 'the roster lists only the publishers the row can see');
    assert.equal(
      rows[0].roster,
      'components.corroboration.rosterSummaryTier1 components.corroboration.rosterListed',
      'the digest count exceeds the listed publishers, so the summary says how many were listed',
    );
  });

  it('renders the tier badge only for a declared tier', async () => {
    const rows = await renderRows([
      headline('Port authority confirms tanker seizure near strait', 'Unlisted Outlet', '2026-09-20T12:00:00.000Z'),
    ], {});
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tierBadge, null);
    assert.equal(rows[0].flag, 'components.corroboration.singlePublisher');
  });
});
