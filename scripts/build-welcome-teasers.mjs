#!/usr/bin/env node
// Generate pro-test/src/generated/teasers.json from the committed crawlable
// live-pulse snapshot.
//
// Usage:
//   node scripts/build-welcome-teasers.mjs            # write
//   node scripts/build-welcome-teasers.mjs --check    # fail if stale
//
// Why this file is generated rather than hand-curated
// ---------------------------------------------------
// The root welcome strip renders this fallback immediately, INCLUDING into the
// SEO prerender, while the live fetch runs. A crawler therefore reads it as
// published fact, under an H2 that asks "What live data is this page showing
// right now?".
//
// Hand-curation lapsed exactly as you would expect (#7608): the headline card
// published four invented headlines under real Reuters/FT/AP/BBC bylines, and
// the CII/chokepoint numbers had drifted until they inverted which waterway was
// in crisis -- the homepage showed Bab el-Mandeb red and Hormuz yellow while
// the same day's snapshot held Hormuz Red 70 and Bab el-Mandeb Yellow 40.
//
// The determinism rule that kept this hand-written still holds and is not
// relaxed here: NEVER fetch live data during `npm run build`, because the
// deploy runs `npm run build:pro` and network data would make every deploy emit
// different bytes for the same commit. This generator reads only a COMMITTED
// snapshot, which is a repo input -- the same guarantee the crawlable corpus
// build already relies on. The network step stays factored out into
// `npm run freeze:crawlable-live-pulse`, and the corpus build's 10-day
// staleness ceiling covers these values too.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveLatestLivePulseSnapshotPath } from './build-crawlable-corpus.mjs';
import { parseCiiMovement } from './crawlable-live-tools.mjs';
import { isVerifiableArticleUrl } from './freeze-crawlable-live-pulse.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');

export const TEASERS_OUTPUT_PATH = 'pro-test/src/generated/teasers.json';

// The strip renders five rows per data card and four headlines.
const CHOKEPOINT_STATUSES = new Set(['green', 'yellow', 'red']);
const CII_ROWS = 5;
const CHOKEPOINT_ROWS = 5;
const HEADLINE_ROWS = 4;

const { CHOKEPOINT_REGISTRY } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'config', 'chokepoint-registry.ts')).href
);

const DISPLAY_NAME_BY_SLUG = new Map(
  CHOKEPOINT_REGISTRY.map((entry) => [entry.id, entry.displayName]),
);

// Market quotes have no frozen source: the pulse snapshot captures risk,
// chokepoint and crisis state, not prices. These stay illustrative sample
// values, and unlike the headline card they make no attribution claim -- no
// exchange, vendor or masthead is named, and the card carries the SAMPLE badge
// until the live fetch replaces it. Kept here rather than in the generated JSON
// so `--check` covers the whole file.
const SAMPLE_QUOTES = [
  { symbol: '^GSPC', display: 'S&P 500', price: 6053.1, change: 0.42, sparkline: [5982, 5991, 6004, 5998, 6012, 6027, 6021, 6035, 6042, 6039, 6048, 6053] },
  { symbol: '^IXIC', display: 'Nasdaq', price: 20231.8, change: 0.67, sparkline: [19980, 20012, 20045, 20010, 20092, 20135, 20108, 20156, 20182, 20163, 20205, 20232] },
  { symbol: '^VIX', display: 'VIX', price: 18.42, change: -2.15, sparkline: [19.2, 19.0, 18.8, 18.9, 18.7, 18.6, 18.8, 18.5, 18.4, 18.6, 18.5, 18.4] },
  { symbol: 'BTC', display: 'Bitcoin', price: 104850, change: -1.23, sparkline: [106900, 106400, 106800, 106100, 105600, 105900, 105200, 104800, 105100, 104600, 104900, 104850] },
  { symbol: 'ETH', display: 'Ethereum', price: 2524, change: -0.74, sparkline: [2580, 2564, 2571, 2550, 2541, 2555, 2538, 2526, 2535, 2518, 2527, 2524] },
  { symbol: 'CL=F', display: 'WTI crude', price: 72.44, change: 1.18, sparkline: [71.2, 71.4, 71.1, 71.6, 71.9, 71.7, 72.1, 72.3, 72.0, 72.5, 72.2, 72.4] },
  { symbol: 'BZ=F', display: 'Brent', price: 76.18, change: 1.04, sparkline: [75.0, 75.2, 75.1, 75.5, 75.7, 75.6, 75.9, 76.1, 75.8, 76.2, 76.0, 76.2] },
  { symbol: 'GC=F', display: 'Gold', price: 3312.4, change: 0.31, sparkline: [3295, 3298, 3301, 3299, 3304, 3308, 3306, 3310, 3307, 3311, 3309, 3312] },
  { symbol: 'HG=F', display: 'Copper', price: 4.91, change: 1.46, sparkline: [4.78, 4.80, 4.79, 4.83, 4.86, 4.85, 4.88, 4.90, 4.87, 4.92, 4.90, 4.91] },
  { symbol: 'NG=F', display: 'Nat gas', price: 3.18, change: -0.58, sparkline: [3.24, 3.22, 3.25, 3.21, 3.20, 3.23, 3.19, 3.17, 3.18, 3.16, 3.19, 3.18] },
  { symbol: 'EURUSD=X', display: 'EUR/USD', price: 1.08, change: 0.12, sparkline: [1.076, 1.077, 1.077, 1.078, 1.079, 1.078, 1.080, 1.081, 1.080, 1.082, 1.081, 1.082] },
  { symbol: 'USDJPY=X', display: 'USD/JPY', price: 144.2, change: -0.21, sparkline: [144.8, 144.6, 144.7, 144.5, 144.4, 144.6, 144.3, 144.1, 144.2, 144.0, 144.3, 144.2] },
];

// The snapshot stores CII movement as operator prose ("Rising +12"); the strip
// renders a trend glyph keyed off the proto enum suffix.
//
// parseCiiMovement is the canonical parser for this exact string shape and
// throws on anything it does not recognise, so an unexpected label reds the
// generator instead of being published as a confident direction. The one thing
// it treats as a value rather than an error is "Stable or unavailable" -- the
// upstream saying it does not know -- which must NOT become a published
// "stable" claim, so it maps to UNSPECIFIED. LiveStrip's trendGlyph already
// renders the neutral glyph for any unrecognised suffix.
function trendDirection(trend) {
  const raw = String(trend || '').trim();
  if (!raw || raw.startsWith('Stable or unavailable')) return 'TREND_DIRECTION_UNSPECIFIED';
  const { change24h } = parseCiiMovement(raw);
  if (change24h === null) return 'TREND_DIRECTION_UNSPECIFIED';
  if (change24h > 0) return 'TREND_DIRECTION_RISING';
  if (change24h < 0) return 'TREND_DIRECTION_FALLING';
  return 'TREND_DIRECTION_STABLE';
}

function headlineRow(headline, index) {
  const title = String(headline?.title || '').trim();
  const source = String(headline?.source || '').trim();
  const url = String(headline?.url || '').trim();
  const publishedAt = Date.parse(headline?.publishedAt);
  // The freeze already enforces all of this; re-enforcing it here means a
  // hand-edited snapshot cannot put an unattributable headline on the homepage
  // either. isVerifiableArticleUrl is imported from the freeze rather than
  // restated, so the two sides cannot drift into enforcing different rules.
  if (!title || !source || !isVerifiableArticleUrl(url) || !Number.isFinite(publishedAt)) {
    throw new Error(
      `unpublishable headline at index ${index}: every row needs a title, a masthead, `
      + `a verifiable https article URL and a publication time (got ${JSON.stringify(headline)})`,
    );
  }
  // pro-test/prerender.mjs hard-fails the deploy when the SSR markup contains
  // the literal "undefined" (its locale-key guard). Headline text is third-party
  // now, so catch it here -- a broken publisher permalink reds this generator,
  // not the weekly refresh's build step.
  if (`${title} ${url}`.includes('undefined')) {
    throw new Error(
      `unpublishable headline at index ${index}: contains the literal "undefined", which trips `
      + 'the prerender deploy guard in pro-test/prerender.mjs',
    );
  }
  return { title, source, url, publishedAt };
}

export function buildWelcomeTeasers(snapshot, snapshotPath) {
  // An empty capture publishes an empty card. That is the honest degradation:
  // the freeze records and warns about a shortfall rather than throwing (a news
  // outage must not cost the corpus its country refresh), and showing nothing
  // beats showing rows this snapshot cannot vouch for -- which is #7608.
  const headlines = Array.isArray(snapshot?.headlines) ? snapshot.headlines : [];

  const cii = Object.entries(snapshot.countries)
    // A partial capture carries `score: null`, and Number(null) is 0 -- which is
    // finite, so a plain isFinite filter would publish those countries at 0
    // rather than exclude them. Number('') is 0 and finite for the same reason.
    // Reject an absent score explicitly, before any numeric coercion.
    .filter(([, row]) => row?.partial !== true && String(row?.score ?? '').trim() !== '')
    .map(([region, row]) => ({
      region,
      combinedScore: Number(row?.score),
      trend: trendDirection(row?.trend),
    }))
    .filter((row) => Number.isFinite(row.combinedScore))
    .sort((a, b) => b.combinedScore - a.combinedScore || a.region.localeCompare(b.region))
    .slice(0, CII_ROWS);

  const chokepointRows = Object.entries(snapshot.chokepoints).map(([slug, row]) => {
    const name = DISPLAY_NAME_BY_SLUG.get(slug);
    if (!name) {
      throw new Error(
        `${snapshotPath} holds chokepoint "${slug}", which src/config/chokepoint-registry.ts `
        + 'does not define — the strip would publish a raw identifier as a place name',
      );
    }
    const status = String(row?.status || '').toLowerCase();
    const disruptionScore = Number(row?.disruptionScore);
    // #7608 was an inverted status/score pair reaching the prerender. Refuse the
    // shapes that would publish a wrong one silently: an unknown status renders
    // a grey dot beside a real waterway, and a non-finite score serialises to
    // null, renders as 0, and makes the severity comparator return NaN -- which
    // is falsy, so the "worst first" ordering degrades to snapshot key order.
    if (!CHOKEPOINT_STATUSES.has(status)) {
      throw new Error(
        `${snapshotPath} holds chokepoint "${slug}" with status "${row?.status}", which is not one of `
        + `${[...CHOKEPOINT_STATUSES].join('/')} — the strip would publish an unreadable severity`,
      );
    }
    if (!Number.isFinite(disruptionScore) || disruptionScore < 0 || disruptionScore > 100) {
      throw new Error(
        `${snapshotPath} holds chokepoint "${slug}" with disruptionScore "${row?.disruptionScore}", `
        + 'which is not a 0-100 number — the strip would publish it as 0 and mis-sort the card',
      );
    }
    return { name, status, disruptionScore };
  });

  return {
    headlines: headlines.slice(0, HEADLINE_ROWS).map(headlineRow),
    cii,
    chokepoints: [...chokepointRows]
      .sort((a, b) => b.disruptionScore - a.disruptionScore || a.name.localeCompare(b.name))
      .slice(0, CHOKEPOINT_ROWS),
    // Both halves of "N of M disrupted" are counted across every captured
    // chokepoint. Deriving the numerator in the client from the five rendered
    // rows published "5 of 13" against a real 7 of 13 (mirrors fetchChokepoints
    // in teasers.ts, which counts across the full set).
    chokepointDisrupted: chokepointRows.filter((row) => row.status !== 'green').length,
    chokepointTotal: chokepointRows.length,
    quotes: SAMPLE_QUOTES,
  };
}

function comment(snapshotPath, capturedAt) {
  return (
    'AUTO-GENERATED by scripts/build-welcome-teasers.mjs. DO NOT EDIT. '
    + `Source: ${snapshotPath} (captured ${capturedAt}). `
    + 'Fallback for the root welcome live-teaser strip: rendered immediately (and into '
    + 'the SEO prerender) while the live fetch runs, then replaced in place when live '
    + 'data arrives. Every headline, score and status here is a frozen capture of real '
    + 'published data, never an illustrative example — a crawler reads this markup as '
    + 'fact (#7608). Refresh with `npm run freeze:crawlable-live-pulse && npm run '
    + 'teasers:welcome`; NEVER fetch live data during `npm run build`, since the deploy '
    + 'runs `npm run build:pro` and build-time network data would make every deploy emit '
    + 'different bytes for the same commit.'
  );
}

export async function renderWelcomeTeasers({ rootDir = REPO_ROOT } = {}) {
  const snapshotPath = resolveLatestLivePulseSnapshotPath(rootDir);
  const snapshot = JSON.parse(readFileSync(join(rootDir, snapshotPath), 'utf8'));
  const teasers = buildWelcomeTeasers(snapshot, snapshotPath);
  return `${JSON.stringify({ _comment: comment(snapshotPath, snapshot.capturedAt), ...teasers }, null, 2)}\n`;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === __filename;
if (isMain) {
  const check = process.argv.includes('--check');
  const outPath = join(REPO_ROOT, TEASERS_OUTPUT_PATH);
  const expected = await renderWelcomeTeasers();
  if (check) {
    const actual = readFileSync(outPath, 'utf8');
    if (actual !== expected) {
      console.error(
        `[build-welcome-teasers] ${TEASERS_OUTPUT_PATH} is stale. Run \`npm run teasers:welcome\`.`,
      );
      process.exitCode = 1;
    } else {
      console.log(`[build-welcome-teasers] ${TEASERS_OUTPUT_PATH} is current`);
    }
  } else {
    writeFileSync(outPath, expected, 'utf8');
    console.log(`[build-welcome-teasers] wrote ${TEASERS_OUTPUT_PATH}`);
  }
}
