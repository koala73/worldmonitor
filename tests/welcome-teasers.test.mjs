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
import {
  QUOTE_LABELS as FROZEN_QUOTE_LABELS,
  QUOTE_SYMBOLS as FROZEN_QUOTE_SYMBOLS,
  downsampleSparkline,
} from '../scripts/freeze-crawlable-live-pulse.mjs';
import {
  QUOTE_LABELS as CLIENT_QUOTE_LABELS,
  QUOTE_SYMBOLS as CLIENT_QUOTE_SYMBOLS,
  getFallbackTeasers,
} from '../pro-test/src/services/teasers.ts';
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
    assert.ok(committed.headlines.length <= 4, 'the fail-soft strip publishes at most four rows');
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

  it('records whether the committed headline capture was stale', () => {
    assert.ok(Object.hasOwn(snapshot.coverage, 'headlineDigestState'));
    assert.ok(Object.hasOwn(snapshot.coverage, 'headlineServedStale'));
    assert.ok(
      snapshot.coverage.headlineDigestState === null
      || typeof snapshot.coverage.headlineDigestState === 'string',
    );
    assert.ok(
      snapshot.coverage.headlineServedStale === null
      || typeof snapshot.coverage.headlineServedStale === 'boolean',
    );
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

  it('publishes only market quotes the capture actually returned', () => {
    // Until #7608 these twelve rows were hand-written and had drifted to a 22%
    // error on the S&P and a 30% error on Bitcoin -- specific false numbers
    // about named instruments, crawlable under "What live data is this page
    // showing right now?".
    const expected = buildWelcomeTeasers(
      snapshot,
      resolveLatestLivePulseSnapshotPath(repoRoot),
    ).quotes;
    assert.deepEqual(
      committed.quotes,
      expected,
      'the tape must publish exactly the captured rows, including an honest empty capture',
    );
    for (const quote of committed.quotes) {
      assert.ok(Number.isFinite(quote.price) && quote.price > 0, `${quote.symbol} needs a real price`);
    }
  });

  it('keeps the freeze quote config in step with the strip that renders it', () => {
    // pro-test is an isolated package, so the symbol list and labels are
    // duplicated in scripts/freeze-crawlable-live-pulse.mjs on purpose. Pin
    // them: a symbol added on one side only would silently never be frozen.
    assert.deepEqual(FROZEN_QUOTE_SYMBOLS, CLIENT_QUOTE_SYMBOLS);
    assert.deepEqual(FROZEN_QUOTE_LABELS, CLIENT_QUOTE_LABELS);
  });

  it('renders the tape in the strip order, never response order', () => {
    const order = committed.quotes.map((quote) => quote.symbol);
    const expected = CLIENT_QUOTE_SYMBOLS.filter((symbol) => order.includes(symbol));
    assert.deepEqual(order, expected);
  });

  it('ranks the strip by severity, so the worst chokepoint is the one shown first', () => {
    const scores = committed.chokepoints.map((row) => row.disruptionScore);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
    const ciiScores = committed.cii.map((row) => row.combinedScore);
    assert.deepEqual(ciiScores, [...ciiScores].sort((a, b) => b - a));
  });
});

describe('welcome teaser strip carries its snapshot stamp (#7654)', () => {
  it('commits the snapshot capture date alongside the rows', () => {
    // The prerender badge names the freeze the rows came from. Without the
    // date travelling in the same file, the badge cannot name it and the
    // strip falls back to calling real data "Sample" — the inverse of #7608.
    assert.equal(
      committed.capturedAt,
      snapshot.capturedAt,
      'teasers.json must carry the snapshot capture date for the Published-pulse badge',
    );
  });

  it('the fallback state exposes the capture date for the prerender badge', () => {
    assert.equal(
      getFallbackTeasers().capturedAt,
      snapshot.capturedAt,
      'the prerender renders the fallback, so the fallback must carry the capture date',
    );
  });

  it('derives the homepage lastmod and dateModified from the same snapshot', () => {
    // The strip and the page dates must refresh on one command
    // (`npm run teasers:welcome`), or the next freeze leaves the strip
    // publishing a newer capture under an older page date.
    const welcome = read('pro-test/welcome.html');
    assert.match(
      welcome,
      new RegExp(`<meta name="lastmod" content="${snapshot.capturedAt}"`),
      'homepage lastmod must be the snapshot capture date, not a hand-maintained stamp',
    );
    assert.match(
      welcome,
      new RegExp(`"dateModified": "${snapshot.capturedAt}"`),
      'homepage dateModified must agree with lastmod on the same snapshot date',
    );
  });

  it('badges the snapshot rows as a published pulse, never a sample', () => {
    // A crawler reading "Instability index · Sample · UA 99" discounts a
    // correct, current number. The badge must use the corpus wording with a
    // machine-readable stamp, matching /countries/* and /chokepoints/*.
    const strip = read('pro-test/src/welcome/LiveStrip.tsx');
    const en = JSON.parse(read('pro-test/src/locales/en.json'));
    assert.match(strip, /data-live-updated/, 'the badge must carry the corpus live-updated marker');
    assert.match(strip, /welcome\.live\.pulseBadge/, 'the badge must use the Published-pulse key');
    assert.equal(
      en.welcome.live.pulseBadge,
      'Published pulse {{date}}',
      'the badge wording must match the corpus pages',
    );
    assert.doesNotMatch(strip, /sampleBadge/, 'no card may badge real snapshot rows as a sample');
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
      quotes: [
        { symbol: '^GSPC', display: 'S&P 500', price: 7747.71, change: 1.06, sparkline: [7702, 7715, 7747] },
        { symbol: 'BTC', display: 'Bitcoin', price: 80697, change: 3.98, sparkline: [77561, 79000, 80697] },
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
      ['url', 'https://news.google.com./rss/articles/CBMifzFBVV95cUx'],
      ['url', 'https://'],
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

  it('preserves valid third-party text and URLs containing undefined', () => {
    const fixture = snapshotFixture();
    fixture.headlines[0].title = 'Publisher explains why a value was undefined';
    fixture.headlines[0].url = 'https://publisher.example/articles/undefined-value';
    const built = buildWelcomeTeasers(fixture, 'docs/snapshots/x.json');
    assert.equal(built.headlines[0].title, fixture.headlines[0].title);
    assert.equal(built.headlines[0].url, fixture.headlines[0].url);
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

  it('rejects a market quote it cannot source', () => {
    for (const patch of [
      { price: undefined },
      { price: 0 },
      { price: -1 },
      { change: 'n/a' },
      { symbol: 'DOGE' },
      { sparkline: [1, 'x', 3] },
    ]) {
      const fixture = snapshotFixture();
      Object.assign(fixture.quotes[0], patch);
      assert.throws(
        () => buildWelcomeTeasers(fixture, 'docs/snapshots/x.json'),
        /quote/i,
        `a quote with ${JSON.stringify(patch)} must not reach the homepage`,
      );
    }
  });

  it('publishes an empty tape rather than an invented one', () => {
    const built = buildWelcomeTeasers(snapshotFixture({ quotes: [] }), 'docs/snapshots/x.json');
    assert.deepEqual(built.quotes, []);
  });

  it('downsamples a sparkline to an even sample that keeps both endpoints', () => {
    const series = Array.from({ length: 390 }, (_, i) => i);
    const reduced = downsampleSparkline(series, 12);
    assert.equal(reduced.length, 12);
    assert.equal(reduced[0], 0, 'the frozen curve must start where the real series does');
    assert.equal(reduced.at(-1), 389, 'and end where it ends');
    assert.deepEqual(reduced, [...reduced].sort((a, b) => a - b), 'order is preserved');
    // A shorter series is kept whole rather than padded.
    assert.deepEqual(downsampleSparkline([1, 2, 3], 12), [1, 2, 3]);
    assert.deepEqual(downsampleSparkline(undefined, 12), []);
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
