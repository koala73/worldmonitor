/**
 * Watchlist story alerts — digest-scan event source (#4922 item e / U3).
 *
 * Two surfaces:
 *  1. Unit tests for the pure builder in scripts/lib/watchlist-story-events.mjs
 *     (extraction + threshold + event-shape decisions).
 *  2. Source-grep contract on scripts/seed-digest-notifications.mjs and
 *     scripts/lib/watchlist-story-scan.mjs — the cron is a runtime
 *     side-effect module, so only the wrapper wiring stays in the cron body
 *     while the Redis orchestration lives in an importable helper.
 *
 * Run: node --test tests/watchlist-story-events.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTickerDictionary } from '../shared/ticker-extract.js';
import {
  buildWatchlistStoryEvents,
  resolveWatchlistScoreMin,
  DEFAULT_WATCHLIST_STORY_SCORE_MIN,
  WATCHLIST_STORY_EVENT_TYPE,
} from '../scripts/lib/watchlist-story-events.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const digestSrc = readFileSync(
  resolve(__dirname, '..', 'scripts', 'seed-digest-notifications.mjs'),
  'utf-8',
);
const scanSrc = readFileSync(
  resolve(__dirname, '..', 'scripts', 'lib', 'watchlist-story-scan.mjs'),
  'utf-8',
);
const relaySrc = readFileSync(
  resolve(__dirname, '..', 'scripts', 'notification-relay.cjs'),
  'utf-8',
);

const DICT = buildTickerDictionary([
  // 'Microsoft' (distinctive) drives the builder fixtures; 'Apple' is an
  // ambiguous common-word name excluded from bare-name matching, so it would
  // never tag here — the builder logic under test is name-agnostic.
  { symbol: 'MSFT', name: 'Microsoft' },
  { symbol: 'LLY', name: 'Eli Lilly' },
]);

const story = (over = {}) => ({
  hash: 'h1',
  title: 'Microsoft faces new antitrust probe',
  description: '',
  link: 'https://example.com/a',
  source: 'Example Wire',
  currentScore: 74,
  ...over,
});

describe('buildWatchlistStoryEvents — pure builder', () => {
  it('ticker match at/above threshold enqueues one event with the fixed payload shape', () => {
    const events = buildWatchlistStoryEvents([story()], DICT, 69);
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.equal(ev.eventType, WATCHLIST_STORY_EVENT_TYPE);
    assert.deepEqual(ev.payload, {
      title: 'Microsoft faces new antitrust probe',
      link: 'https://example.com/a',
      source: 'Example Wire',
      tickers: ['MSFT'],
      importanceScore: 74,
      coalesceKey: 'watchlist:h1',
    });
  });

  it('coalesceKey embeds the stable story hash — the anti-re-alert identity', () => {
    const events = buildWatchlistStoryEvents([story({ hash: 'deadbeef' })], DICT, 69);
    assert.equal(events[0].payload.coalesceKey, 'watchlist:deadbeef');
  });

  it('below-threshold stories are dropped even with tickers', () => {
    assert.deepEqual(buildWatchlistStoryEvents([story({ currentScore: 68 })], DICT, 69), []);
  });

  it('threshold is inclusive (score === scoreMin fires)', () => {
    assert.equal(buildWatchlistStoryEvents([story({ currentScore: 69 })], DICT, 69).length, 1);
  });

  it('stories without tickers are dropped even above threshold', () => {
    const events = buildWatchlistStoryEvents(
      [story({ title: 'Earthquake strikes region', currentScore: 95 })],
      DICT,
      69,
    );
    assert.deepEqual(events, []);
  });

  it('description participates in extraction (title has no ticker, description does)', () => {
    const events = buildWatchlistStoryEvents(
      [story({ title: 'Weight-loss drug demand soars', description: 'Eli Lilly ramps production.' })],
      DICT,
      69,
    );
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].payload.tickers, ['LLY']);
  });

  it('cashtags fire without dictionary membership', () => {
    const events = buildWatchlistStoryEvents(
      [story({ title: 'Traders pile into $TSM ahead of earnings' })],
      DICT,
      69,
    );
    assert.deepEqual(events[0].payload.tickers, ['TSM']);
  });

  it('severity maps from the relay score bands: >=82 critical, else high', () => {
    // 82/69 mirror the relay's shouldNotify thresholds
    // (scripts/notification-relay.cjs ~776-783: critical=82, high=69).
    assert.equal(buildWatchlistStoryEvents([story({ currentScore: 81 })], DICT, 69)[0].severity, 'high');
    assert.equal(buildWatchlistStoryEvents([story({ currentScore: 82 })], DICT, 69)[0].severity, 'critical');
  });

  it('malformed rows (missing hash/title, non-finite score) are skipped, not thrown', () => {
    const events = buildWatchlistStoryEvents(
      [null, {}, story({ hash: '' }), story({ title: '' }), story({ currentScore: Number.NaN }), story()],
      DICT,
      69,
    );
    assert.equal(events.length, 1);
  });
});

describe('resolveWatchlistScoreMin — env threshold', () => {
  it("defaults to 69 — the relay's 'high' importance gate", () => {
    assert.equal(DEFAULT_WATCHLIST_STORY_SCORE_MIN, 69);
    assert.equal(resolveWatchlistScoreMin({}), 69);
    assert.equal(resolveWatchlistScoreMin(undefined), 69);
    // Lock the alignment against the relay source itself.
    assert.match(
      relaySrc,
      /:\s*effectiveSensitivity === 'high' \? 69/,
      "relay 'high' threshold moved — realign DEFAULT_WATCHLIST_STORY_SCORE_MIN",
    );
  });

  it('honors WATCHLIST_STORY_SCORE_MIN when a valid non-negative integer', () => {
    assert.equal(resolveWatchlistScoreMin({ WATCHLIST_STORY_SCORE_MIN: '80' }), 80);
    assert.equal(resolveWatchlistScoreMin({ WATCHLIST_STORY_SCORE_MIN: '0' }), 0);
  });

  it('rejects garbage back to the default', () => {
    assert.equal(resolveWatchlistScoreMin({ WATCHLIST_STORY_SCORE_MIN: '-5' }), 69);
    assert.equal(resolveWatchlistScoreMin({ WATCHLIST_STORY_SCORE_MIN: 'high' }), 69);
  });
});

describe('seed-digest-notifications.mjs — enqueue wiring (source-grep contract)', () => {
  it('wires the importable scan helper and the shared ticker dictionary', () => {
    assert.match(
      digestSrc,
      /from '\.\/lib\/watchlist-story-scan\.mjs'/,
      'cron must delegate Redis orchestration to the watchlist-story-scan helper',
    );
    assert.match(
      digestSrc,
      /buildTickerDictionary/,
      'cron must compile the ticker dictionary once at module load',
    );
    assert.match(
      digestSrc,
      /require\('\.\.\/shared\/stocks\.json'\)/,
      'cron must load shared/stocks.json via the createRequire JSON pattern (diplomacy-keywords precedent)',
    );
  });

  it('carries the @notification-source tag (payload-audit convention)', () => {
    assert.match(digestSrc, /@notification-source:\s*rss\b/);
  });

  it('publishes via the SET-NX scan-dedup → LPUSH wm:events:queue → DEL-rollback pattern', () => {
    assert.match(
      scanSrc,
      /wm:notif:scan-dedup:/,
      'publisher must dedup on the shared scan-dedup keyspace',
    );
    assert.match(
      scanSrc,
      /buildDedupMaterial\(/,
      'publisher dedup material must come from the shared notification-dedup helper',
    );
    assert.match(
      scanSrc,
      /'LPUSH',\s*'wm:events:queue'/,
      'events must be LPUSHed onto the queue the notification relay consumes',
    );
    assert.match(
      scanSrc,
      /rolling back dedup key/i,
      'LPUSH failure must roll back the dedup key (ais-relay publishNotificationEvent parity)',
    );
  });

  it('scan runs once per cron tick from main(), independent of digest rules', () => {
    assert.match(
      digestSrc,
      /await scanAndEnqueueWatchlistStoryEvents\(nowMs\)/,
      'main() must await the watchlist scan',
    );
    // The scan must run BEFORE the digest-rules fetch so an empty/failed
    // rules fetch cannot suppress watchlist alerts.
    const scanIdx = digestSrc.indexOf('await scanAndEnqueueWatchlistStoryEvents(nowMs)');
    const rulesIdx = digestSrc.indexOf("fetch(`${CONVEX_SITE_URL}/relay/digest-rules`");
    assert.ok(scanIdx > 0 && rulesIdx > 0 && scanIdx < rulesIdx,
      'watchlist scan must run before the digest-rules fetch in main()');
  });

  it('threshold comes from WATCHLIST_STORY_SCORE_MIN via resolveWatchlistScoreMin', () => {
    assert.match(scanSrc, /resolveWatchlistScoreMin\(env\)/);
  });

  it('hydrates sources using the candidate hash rather than parsing coalesceKey', () => {
    assert.ok(scanSrc.includes('sourceKey: `story:sources:v1:${candidate.hash}`'));
    assert.doesNotMatch(scanSrc, /coalesceKey\)\.slice\('watchlist:'/);
  });
});
