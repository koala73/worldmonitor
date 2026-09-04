#!/usr/bin/env node
// Generate pro-test/src/generated/teasers.json from the committed crawlable
// live-pulse snapshot.
//
// Usage:
//   node scripts/build-welcome-teasers.mjs            # write
//   node scripts/build-welcome-teasers.mjs --check    # fail if stale
//
// The generator owns two committed artifacts: pro-test/src/generated/teasers.json
// (the strip rows plus the capture date the Published-pulse badge names) and
// the date metadata in pro-test/welcome.html (`lastmod` + `dateModified`).
// Both refresh on this one command so a new freeze can never leave the strip
// publishing a newer capture under an older page date (#7654).
//
// Why this file is generated rather than hand-curated
// ---------------------------------------------------
// The root welcome strip renders this fallback immediately, INCLUDING into the
// SEO prerender, while the live fetch runs. A crawler therefore reads it as
// published fact, under an H2 that asks "What live data is this page showing
// right now?".
//
// Hand-curation lapsed exactly as you would expect (#7608): the headline card
// published four invented headlines under real Reuters/FT/AP/BBC bylines, the
// CII/chokepoint numbers had drifted until they inverted which waterway was in
// crisis -- the homepage showed Bab el-Mandeb red and Hormuz yellow while the
// same day's snapshot held Hormuz Red 70 and Bab el-Mandeb Yellow 40 -- and the
// market tape quoted the S&P 22% low and Bitcoin 30% high.
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
import { QUOTE_LABELS, isVerifiableArticleUrl } from './freeze-crawlable-live-pulse.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');

export const TEASERS_OUTPUT_PATH = 'pro-test/src/generated/teasers.json';
export const WELCOME_HTML_PATH = 'pro-test/welcome.html';

// The strip renders five rows per data card and four headlines.
const CHOKEPOINT_STATUSES = new Set(['green', 'yellow', 'red']);
const CII_ROWS = 5;
const CHOKEPOINT_ROWS = 5;
const HEADLINE_ROWS = 4;
const CAPTURED_AT_RE = /^\d{4}-\d{2}-\d{2}$/;

const { CHOKEPOINT_REGISTRY } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'config', 'chokepoint-registry.ts')).href
);

const DISPLAY_NAME_BY_SLUG = new Map(
  CHOKEPOINT_REGISTRY.map((entry) => [entry.id, entry.displayName]),
);

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
  return { title, source, url, publishedAt };
}

// The tape names real instruments, so a row that cannot be sourced is dropped
// rather than defaulted. Until #7608 these twelve rows were hand-written and had
// drifted to a 22% error on the S&P and a 30% error on Bitcoin -- crawlable,
// specific, and false, under a heading asking what live data the page shows.
function quoteRow(quote, index, snapshotPath) {
  const symbol = String(quote?.symbol || '').trim();
  const price = Number(quote?.price);
  const change = Number(quote?.change);
  const sparkline = Array.isArray(quote?.sparkline) ? quote.sparkline.map(Number) : [];
  if (!QUOTE_LABELS[symbol]) {
    throw new Error(
      `${snapshotPath} holds quote "${symbol}" at index ${index}, which the strip does not render`,
    );
  }
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(change)) {
    throw new Error(
      `${snapshotPath} holds quote "${symbol}" with price ${quote?.price} / change ${quote?.change}; `
      + 'the tape would publish a made-up number for a real instrument',
    );
  }
  if (!sparkline.every((value) => Number.isFinite(value))) {
    throw new Error(`${snapshotPath} holds quote "${symbol}" with a non-numeric sparkline point`);
  }
  return { symbol, display: QUOTE_LABELS[symbol], price, change, sparkline };
}

export function buildWelcomeTeasers(snapshot, snapshotPath) {
  // The badge names the freeze behind the rows ("Published pulse Sep 4,
  // 2026"), so the capture date is output, not decoration. A missing or
  // misshapen date reds the generator rather than publishing undated fact
  // claims — the same fail-closed contract as an unpublishable headline.
  const capturedAt = String(snapshot?.capturedAt || '').trim();
  if (!CAPTURED_AT_RE.test(capturedAt)) {
    throw new Error(
      `${snapshotPath} holds capturedAt ${JSON.stringify(snapshot?.capturedAt)}, `
      + 'which is not a YYYY-MM-DD date — the strip badge cannot attribute the rows without it',
    );
  }
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
    capturedAt,
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
    // Same fail-soft contract as the headline card: publish exactly what the
    // capture vouched for, including nothing. The live fetch replaces the tape
    // a moment later for a real visitor; a crawler reads frozen real prices or
    // no prices, never invented ones.
    quotes: (Array.isArray(snapshot?.quotes) ? snapshot.quotes : [])
      .map((quote, index) => quoteRow(quote, index, snapshotPath)),
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

// The homepage is the strip's host page, so its crawler-facing dates track
// the same freeze the strip reads. Exactly one lastmod meta and one
// dateModified JSON-LD node exist in the template; anything else (zero, two)
// is a template edit this sync must not silently reinterpret — fail closed.
export function renderWelcomeHtml({ rootDir = REPO_ROOT, capturedAt } = {}) {
  const htmlPath = join(rootDir, WELCOME_HTML_PATH);
  const html = readFileSync(htmlPath, 'utf8');
  const lastmodMatches = html.match(/<meta name="lastmod" content="\d{4}-\d{2}-\d{2}" \/>/g) || [];
  const dateModifiedMatches = html.match(/"dateModified": "\d{4}-\d{2}-\d{2}"/g) || [];
  if (lastmodMatches.length !== 1 || dateModifiedMatches.length !== 1) {
    throw new Error(
      `${WELCOME_HTML_PATH} must carry exactly one lastmod meta and one dateModified node `
      + `(found ${lastmodMatches.length} / ${dateModifiedMatches.length}) — refusing to guess which one tracks the strip snapshot`,
    );
  }
  return html
    .replace(/<meta name="lastmod" content="\d{4}-\d{2}-\d{2}" \/>/, `<meta name="lastmod" content="${capturedAt}" />`)
    .replace(/"dateModified": "\d{4}-\d{2}-\d{2}"/, `"dateModified": "${capturedAt}"`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === __filename;
if (isMain) {
  const check = process.argv.includes('--check');
  const snapshotPath = resolveLatestLivePulseSnapshotPath(REPO_ROOT);
  const snapshot = JSON.parse(readFileSync(join(REPO_ROOT, snapshotPath), 'utf8'));
  const teasers = buildWelcomeTeasers(snapshot, snapshotPath);
  const expectedTeasers = `${JSON.stringify({ _comment: comment(snapshotPath, snapshot.capturedAt), ...teasers }, null, 2)}\n`;
  const expectedHtml = renderWelcomeHtml({ rootDir: REPO_ROOT, capturedAt: teasers.capturedAt });
  const outPath = join(REPO_ROOT, TEASERS_OUTPUT_PATH);
  const htmlPath = join(REPO_ROOT, WELCOME_HTML_PATH);
  if (check) {
    const stale = [];
    if (readFileSync(outPath, 'utf8') !== expectedTeasers) stale.push(TEASERS_OUTPUT_PATH);
    if (readFileSync(htmlPath, 'utf8') !== expectedHtml) stale.push(WELCOME_HTML_PATH);
    if (stale.length > 0) {
      console.error(`[build-welcome-teasers] stale: ${stale.join(', ')}. Run \`npm run teasers:welcome\`.`);
      process.exitCode = 1;
    } else {
      console.log(`[build-welcome-teasers] ${TEASERS_OUTPUT_PATH} and ${WELCOME_HTML_PATH} are current`);
    }
  } else {
    writeFileSync(outPath, expectedTeasers, 'utf8');
    writeFileSync(htmlPath, expectedHtml, 'utf8');
    console.log(`[build-welcome-teasers] wrote ${TEASERS_OUTPUT_PATH} and ${WELCOME_HTML_PATH}`);
  }
}
