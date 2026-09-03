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
        UA: { score: '98', trend: 'Rising +12' },
        RU: { score: '78', trend: 'Falling -3' },
        IL: { score: '69', trend: 'Stable' },
        IR: { score: '63', trend: 'Rising +2' },
        PK: { score: '70', trend: '' },
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

  it('rejects a snapshot with no headline capture rather than keeping the old ones', () => {
    assert.throws(
      () => buildWelcomeTeasers(snapshotFixture({ headlines: [] }), 'docs/snapshots/x.json'),
      /no headlines/i,
      'an empty capture must fail the generator, not silently republish stale headlines',
    );
  });

  it('rejects a headline that lost its masthead, link, or publication time', () => {
    for (const [field, value] of [['source', ''], ['url', 'http://example.test/a'], ['publishedAt', '']]) {
      const fixture = snapshotFixture();
      fixture.headlines[0][field] = value;
      assert.throws(
        () => buildWelcomeTeasers(fixture, 'docs/snapshots/x.json'),
        /unpublishable headline/i,
        `a headline missing ${field} must not reach the homepage`,
      );
    }
  });

  it('maps snapshot trend prose onto the strip trend enum', () => {
    const built = buildWelcomeTeasers(snapshotFixture(), 'docs/snapshots/x.json');
    const byRegion = new Map(built.cii.map((row) => [row.region, row.trend]));
    assert.equal(byRegion.get('UA'), 'TREND_DIRECTION_RISING');
    assert.equal(byRegion.get('RU'), 'TREND_DIRECTION_FALLING');
    assert.equal(byRegion.get('IL'), 'TREND_DIRECTION_STABLE');
    assert.equal(byRegion.get('PK'), 'TREND_DIRECTION_STABLE');
  });

  it('resolves chokepoint slugs to their registry display names', () => {
    const built = buildWelcomeTeasers(snapshotFixture(), 'docs/snapshots/x.json');
    assert.deepEqual(
      built.chokepoints.map((row) => row.name),
      ['Strait of Hormuz', 'Bab el-Mandeb', 'Suez Canal', 'Panama Canal', 'Strait of Malacca'],
    );
    assert.equal(built.chokepointTotal, 6, 'the denominator counts every captured chokepoint, not the top five');
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
