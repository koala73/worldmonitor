// The root welcome strip sits under an H2 reading "What live data is this page
// showing right now?" and is server-rendered into the SEO prerender, so a
// crawler reads its fallback values as published claims.
//
// Until #7608 those values were hand-curated prose: four invented headlines
// carrying real Reuters/FT/AP/BBC bylines, and CII/chokepoint numbers that had
// drifted so far they inverted which waterway was in crisis (homepage said Bab
// el-Mandeb red 82 / Hormuz yellow 45; the same day's snapshot had Hormuz Red
// 70 / Bab el-Mandeb Yellow 40).
//
// The fix makes the file derived, not written: every published number and
// headline now comes from the committed live-pulse snapshot. These tests are
// what keeps it that way.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  TEASERS_OUTPUT_PATH,
  buildWelcomeTeasers,
  renderWelcomeTeasers,
} from '../scripts/build-welcome-teasers.mjs';
import { resolveLatestLivePulseSnapshotPath } from '../scripts/build-crawlable-corpus.mjs';
import { CHOKEPOINT_REGISTRY } from '../src/config/chokepoint-registry.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

const snapshot = JSON.parse(read(resolveLatestLivePulseSnapshotPath(repoRoot)));
const committed = JSON.parse(read(TEASERS_OUTPUT_PATH));

describe('welcome teaser strip is derived from the committed pulse snapshot', () => {
  it('the committed teasers.json is exactly what the generator produces', async () => {
    assert.equal(
      read(TEASERS_OUTPUT_PATH),
      await renderWelcomeTeasers({ rootDir: repoRoot }),
      `${TEASERS_OUTPUT_PATH} is stale — run \`npm run teasers:welcome\``,
    );
  });

  it('publishes no headline it cannot attribute and link', () => {
    assert.equal(committed.headlines.length, 4);
    for (const headline of committed.headlines) {
      assert.ok(headline.title.length > 0, 'a headline needs a title');
      assert.ok(headline.source.length > 0, `"${headline.title}" needs a masthead`);
      assert.match(
        headline.url,
        /^https:\/\//,
        `"${headline.title}" carries a masthead, so it must link to the article that backs it`,
      );
      assert.ok(
        Number.isFinite(headline.publishedAt) && headline.publishedAt > 0,
        `"${headline.title}" must carry its real publication time, not the 0 placeholder`,
      );
    }
  });

  it('every published headline came from the snapshot capture', () => {
    const frozen = new Map(snapshot.headlines.map((h) => [h.title, h]));
    for (const headline of committed.headlines) {
      const source = frozen.get(headline.title);
      assert.ok(source, `"${headline.title}" is not in the frozen capture — it was hand-written`);
      assert.equal(headline.source, source.source);
      assert.equal(headline.url, source.url);
      assert.equal(headline.publishedAt, Date.parse(source.publishedAt));
    }
  });

  it('CII scores match the snapshot rather than drifting away from it', () => {
    for (const row of committed.cii) {
      const frozen = snapshot.countries[row.region];
      assert.ok(frozen, `${row.region} is not in the frozen capture`);
      assert.equal(
        row.combinedScore,
        Number(frozen.score),
        `${row.region} publishes ${row.combinedScore} while the snapshot holds ${frozen.score}`,
      );
    }
  });

  it('counts both halves of "N of M disrupted" across the full capture', () => {
    // The numerator used to be derived in the client from the five rendered
    // rows while the denominator came from the full set, so the prerender
    // published "5 of 13" against a real 7 of 13.
    assert.equal(
      committed.chokepointDisrupted,
      Object.values(snapshot.chokepoints).filter((c) => c.status.toLowerCase() !== 'green').length,
      'the disrupted count must span every captured chokepoint, not the display slice',
    );
    assert.ok(
      committed.chokepointDisrupted >= committed.chokepoints.filter((c) => c.status !== 'green').length,
      'the full-capture numerator can never be smaller than the rendered rows',
    );
  });

  it('never publishes a trend the snapshot did not assert', () => {
    for (const row of committed.cii) {
      const frozen = snapshot.countries[row.region];
      const label = String(frozen.trend || '');
      if (!label || label.startsWith('Stable or unavailable')) {
        assert.equal(
          row.trend,
          'TREND_DIRECTION_UNSPECIFIED',
          `${row.region}: the upstream said it does not know, so the strip must not claim a direction`,
        );
      } else {
        assert.match(row.trend, /^TREND_DIRECTION_(RISING|FALLING|STABLE)$/);
      }
    }
  });

  it('publishes only countries the capture actually scored', () => {
    for (const row of committed.cii) {
      const frozen = snapshot.countries[row.region];
      assert.notEqual(frozen.partial, true, `${row.region} was a partial capture and must not be published`);
      assert.notEqual(frozen.score, null, `${row.region} has no score to publish`);
    }
  });

  it('chokepoint status matches the snapshot, so the strip cannot invert a crisis', () => {
    const slugByDisplayName = new Map(
      CHOKEPOINT_REGISTRY.map((entry) => [entry.displayName, entry.id]),
    );
    assert.equal(
      committed.chokepointTotal,
      Object.keys(snapshot.chokepoints).length,
      'the "N of M disrupted" denominator must be the number of chokepoints actually captured',
    );
    for (const row of committed.chokepoints) {
      const slug = slugByDisplayName.get(row.name);
      assert.ok(slug, `${row.name} is not a registry display name`);
      const frozen = snapshot.chokepoints[slug];
      assert.ok(frozen, `${slug} is not in the frozen capture`);
      assert.equal(
        row.status,
        frozen.status.toLowerCase(),
        `${row.name} publishes ${row.status} while the snapshot holds ${frozen.status}`,
      );
      assert.equal(
        row.disruptionScore,
        Number(frozen.disruptionScore),
        `${row.name} publishes ${row.disruptionScore} while the snapshot holds ${frozen.disruptionScore}`,
      );
    }
  });

  it('ranks the strip by severity, so the worst chokepoint is the one shown first', () => {
    const scores = committed.chokepoints.map((row) => row.disruptionScore);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
    const ciiScores = committed.cii.map((row) => row.combinedScore);
    assert.deepEqual(ciiScores, [...ciiScores].sort((a, b) => b - a));
  });
});

describe('welcome teaser generator refuses unpublishable input', () => {
  function snapshotFixture(overrides = {}) {
    return {
      capturedAt: '2026-09-03',
      countries: {
        UA: { partial: false, score: '98', trend: 'Rising +12' },
        RU: { partial: false, score: '78', trend: 'Falling -3' },
        IL: { partial: false, score: '69', trend: 'Stable or unavailable' },
        IR: { partial: false, score: '63', trend: 'Rising +2' },
        PK: { partial: false, score: '70', trend: '' },
        // A partial capture: no score, no trend. Number(null) is 0, which is
        // finite, so a plain isFinite filter would publish this at 0.
        AD: { partial: true, score: null, trend: null },
      },
      chokepoints: {
        hormuz_strait: { disruptionScore: '70', status: 'Red' },
        bab_el_mandeb: { disruptionScore: '40', status: 'Yellow' },
        suez: { disruptionScore: '30', status: 'Yellow' },
        panama: { disruptionScore: '10', status: 'Green' },
        malacca_strait: { disruptionScore: '8', status: 'Green' },
        gibraltar: { disruptionScore: '5', status: 'Green' },
      },
      headlines: [
        {
          title: 'A real headline',
          source: 'UN News',
          url: 'https://news.un.org/story/1',
          publishedAt: '2026-09-03T16:00:00.000Z',
        },
      ],
      ...overrides,
    };
  }

  it('publishes an empty card rather than headlines the capture cannot vouch for', () => {
    // The freeze records and warns about a shortfall instead of throwing, so a
    // news outage costs the strip its rows, not the corpus its country refresh.
    // Showing nothing is the honest floor; showing something invented is #7608.
    const built = buildWelcomeTeasers(snapshotFixture({ headlines: [] }), 'docs/snapshots/x.json');
    assert.deepEqual(built.headlines, []);
    assert.equal(built.cii.length, 5, 'the rest of the strip still publishes');
  });

  it('rejects a headline that lost its masthead, link, or publication time', () => {
    const unpublishable = [
      ['source', ''],
      ['url', 'http://example.test/a'],
      ['publishedAt', ''],
      // An aggregator redirect is the freeze's fourth rule; re-checking it here
      // is what makes headlineRow's "a hand-edited snapshot cannot publish an
      // unattributable headline" comment true rather than aspirational.
      ['url', 'https://news.google.com/rss/articles/CBMifzFBVV95cUx'],
      // pro-test/prerender.mjs hard-fails the deploy on the literal "undefined".
      ['title', 'Publisher CMS emitted undefined in the slug'],
    ];
    for (const [field, value] of unpublishable) {
      const fixture = snapshotFixture();
      fixture.headlines[0][field] = value;
      assert.throws(
        () => buildWelcomeTeasers(fixture, 'docs/snapshots/x.json'),
        /unpublishable headline/i,
        `a headline with ${field}=${JSON.stringify(value)} must not reach the homepage`,
      );
    }
  });

  it('maps snapshot trend prose onto the strip trend enum', () => {
    const built = buildWelcomeTeasers(snapshotFixture(), 'docs/snapshots/x.json');
    const byRegion = new Map(built.cii.map((row) => [row.region, row.trend]));
    assert.equal(byRegion.get('UA'), 'TREND_DIRECTION_RISING');
    assert.equal(byRegion.get('RU'), 'TREND_DIRECTION_FALLING');
    // "Stable or unavailable" and an absent trend are the upstream saying it
    // does not know. Publishing either as STABLE claims a measurement that was
    // never made — the same shape of invented certainty as #7608 itself.
    assert.equal(byRegion.get('IL'), 'TREND_DIRECTION_UNSPECIFIED');
    assert.equal(byRegion.get('PK'), 'TREND_DIRECTION_UNSPECIFIED');
    assert.equal(byRegion.get('AD'), undefined, 'a partial capture has no score to publish');
  });

  it('rejects a trend label the canonical parser does not recognise', () => {
    const fixture = snapshotFixture();
    fixture.countries.UA.trend = 'Plummeting a lot';
    assert.throws(
      () => buildWelcomeTeasers(fixture, 'docs/snapshots/x.json'),
      /Invalid CII movement label/,
      'an unrecognised label must red the generator, not fall through to a confident direction',
    );
  });

  it('rejects a chokepoint whose status or score is unpublishable', () => {
    // These are the two fields #7608 was actually about. An unknown status
    // renders a grey dot beside a real waterway, and a non-finite score
    // serialises to null, renders as 0, and makes the severity comparator
    // return NaN — so "worst first" silently degrades to snapshot key order.
    for (const patch of [{ status: 'amber' }, { status: '' }, { disruptionScore: undefined }, { disruptionScore: '250' }]) {
      const fixture = snapshotFixture();
      Object.assign(fixture.chokepoints.hormuz_strait, patch);
      assert.throws(
        () => buildWelcomeTeasers(fixture, 'docs/snapshots/x.json'),
        /hormuz_strait/,
        `a chokepoint with ${JSON.stringify(patch)} must not reach the homepage`,
      );
    }
  });

  it('resolves chokepoint slugs to their registry display names', () => {
    const built = buildWelcomeTeasers(snapshotFixture(), 'docs/snapshots/x.json');
    assert.deepEqual(
      built.chokepoints.map((row) => row.name),
      ['Strait of Hormuz', 'Bab el-Mandeb', 'Suez Canal', 'Panama Canal', 'Strait of Malacca'],
    );
    assert.equal(built.chokepointTotal, 6, 'the denominator counts every captured chokepoint, not the top five');
    assert.equal(built.chokepointDisrupted, 3, 'the numerator spans the full capture too, not the top five');
  });

  it('rejects a chokepoint slug the registry does not define', () => {
    const fixture = snapshotFixture();
    fixture.chokepoints.atlantis_gap = { disruptionScore: '99', status: 'Red' };
    assert.throws(
      () => buildWelcomeTeasers(fixture, 'docs/snapshots/x.json'),
      /atlantis_gap/,
      'an unknown slug must fail rather than publish a raw identifier as a place name',
    );
  });
});
