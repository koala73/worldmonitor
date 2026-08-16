import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

process.env.UPSTASH_REDIS_REST_URL ??= 'https://stub.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN ??= 'stub-token';
process.env.CONVEX_URL ??= 'https://stub.convex.cloud';
process.env.RELAY_SHARED_SECRET ??= 'stub-secret';
process.env.TELEGRAM_BOT_TOKEN ??= 'stub-bot-token';

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, ...rest) {
  if (request === 'resend') return { Resend: class {} };
  if (request === 'convex/browser') {
    return { ConvexHttpClient: class { async query() {} } };
  }
  return originalLoad.call(this, request, parent, ...rest);
};

// These used to be hand-copied MIRRORS of the relay's predicates, 'kept in sync
// via the source-grep tests below'. A mirror cannot fail when the relay
// changes. The relay only starts its poll loop when require.main === module, so
// requiring it here is side-effect free (same technique as
// tests/notification-relay-country-scope-5359.test.mjs).
const { eventMatchesTickerScope, ruleMatchesEventType } = require(
  resolve(__dirname, '..', 'scripts', 'notification-relay.cjs'),
);

const relaySrc = readFileSync(
  resolve(__dirname, '..', 'scripts', 'notification-relay.cjs'),
  'utf-8',
);
const edgeSrc = readFileSync(resolve(__dirname, '..', 'api', 'notification-channels.ts'), 'utf-8');
const convexHttpSrc = readFileSync(resolve(__dirname, '..', 'convex', 'http.ts'), 'utf-8');
const convexRulesSrc = readFileSync(resolve(__dirname, '..', 'convex', 'alertRules.ts'), 'utf-8');

// The one literal the fixtures below need. It is asserted against the relay's
// own declaration by the source-grep contract further down, so a rename there
// fails loudly rather than silently building fixtures nothing can match.
const WATCHLIST_STORY_EVENT_TYPE = 'watchlist_story_alert';

// Full matching predicate for a rule (eventTypes gate + ticker scope), so the
// behavioural matrix exercises the same conjunction the relay's filter uses.
function matchesWatchlist(rule, event) {
  return ruleMatchesEventType(rule, event) && eventMatchesTickerScope(event, rule);
}


describe('notification-relay watchlist ticker filter — source-grep contract', () => {
  it('declares eventMatchesTickerScope helper', () => {
    assert.match(
      relaySrc,
      /function\s+eventMatchesTickerScope\s*\(\s*event\s*,\s*rule\s*\)/,
      'relay must declare eventMatchesTickerScope(event, rule)',
    );
  });

  it('non-watchlist events bypass the ticker filter (returns true)', () => {
    assert.match(
      relaySrc,
      /if\s*\(\s*event\?\.eventType\s*!==\s*WATCHLIST_STORY_EVENT_TYPE\s*\)\s*return\s+true/,
      'ticker filter must early-return true for every other event type',
    );
  });

  it('opt-in scoped: empty/absent rule.tickers returns false (asymmetric to countries)', () => {
    assert.match(
      relaySrc,
      /if\s*\(\s*!\s*Array\.isArray\(\s*rule\.tickers\s*\)\s*\|\|\s*rule\.tickers\.length\s*===\s*0\s*\)\s*return\s+false/,
      'empty/absent rule.tickers must early-return false — no tickers = no watchlist delivery',
    );
  });

  it('requires explicit eventTypes opt-in — the empty-eventTypes wildcard does NOT cover watchlist events', () => {
    assert.match(
      relaySrc,
      /function\s+ruleMatchesEventType\s*\(\s*rule\s*,\s*event\s*\)/,
      'relay must declare ruleMatchesEventType(rule, event)',
    );
    assert.match(
      relaySrc,
      /return\s+rule\.eventTypes\.includes\(WATCHLIST_STORY_EVENT_TYPE\)/,
      'watchlist events must require explicit eventTypes inclusion',
    );
    // The legacy inline wildcard must be replaced by the helper in the
    // matching filter — otherwise wildcard rules would silently receive
    // watchlist events they never opted into.
    assert.doesNotMatch(
      relaySrc,
      /\(r\.eventTypes\.length === 0 \|\| r\.eventTypes\.includes\(event\.eventType\)\)/,
      'the raw eventTypes wildcard must be routed through ruleMatchesEventType',
    );
  });

  it('watchlist opt-in does not shrink the broadcast wildcard', () => {
    assert.match(
      relaySrc,
      /const\s+broadcastTypes\s*=\s*rule\.eventTypes\.filter\(\s*\(?t\)?\s*=>\s*t\s*!==\s*WATCHLIST_STORY_EVENT_TYPE\s*\)/,
      'ruleMatchesEventType must exclude the watchlist opt-in when evaluating the broadcast wildcard',
    );
  });

  it('filter is wired into the per-rule matching loop alongside shouldNotify + country scope', () => {
    assert.match(
      relaySrc,
      /ruleMatchesEventType\(r,\s*event\)\s*&&\s*\n?\s*shouldNotify\(r,\s*event\)\s*&&\s*\n?\s*eventMatchesCountryScope\(event,\s*r\)\s*&&\s*\n?\s*eventMatchesTickerScope\(event,\s*r\)/,
      'eventMatchesTickerScope must be in the matching filter alongside shouldNotify/eventMatchesCountryScope',
    );
  });

  it('layer-3 PRO gate still guards delivery for every matched rule (fail-closed isUserPro)', () => {
    // The batch PRO check runs on the SAME `matching` set the ticker filter
    // built, and the per-rule delivery loop skips non-PRO users. Watchlist
    // events route through this unchanged code path.
    assert.match(
      relaySrc,
      /const uniqueUserIds = \[\.\.\.new Set\(matching\.map\(r => r\.userId\)\)\]/,
      'batch PRO check must be derived from the matching set',
    );
    assert.match(
      relaySrc,
      /uniqueUserIds\.map\(async uid => \[uid, await isUserPro\(uid\)\]\)/,
      'isUserPro must be consulted per unique user',
    );
    assert.match(
      relaySrc,
      /if \(!proSet\.has\(rule\.userId\)\) continue;/,
      'delivery loop must skip users that failed the PRO gate',
    );
  });
});

describe('notification-relay watchlist ticker filter — behavioural', () => {
  const event = (tickers) => ({
    eventType: WATCHLIST_STORY_EVENT_TYPE,
    severity: 'high',
    payload: {
      title: 'Apple unveils new chip',
      link: 'https://example.com/apple',
      source: 'Example Wire',
      tickers,
      importanceScore: 74,
      coalesceKey: 'watchlist:abc123',
    },
  });
  const rule = (tickers, eventTypes = [WATCHLIST_STORY_EVENT_TYPE]) => ({
    eventTypes,
    tickers,
  });

  it('intersection match delivers', () => {
    assert.equal(matchesWatchlist(rule(['AAPL', 'MSFT']), event(['AAPL', 'TSM'])), true);
  });

  it('disjoint tickers filtered', () => {
    assert.equal(matchesWatchlist(rule(['NVDA', 'MSFT']), event(['AAPL', 'TSM'])), false);
  });

  it('rule without tickers not delivered for this event type (opt-in scoped, unlike countries)', () => {
    assert.equal(matchesWatchlist(rule([], [WATCHLIST_STORY_EVENT_TYPE]), event(['AAPL'])), false);
    assert.equal(matchesWatchlist(rule(undefined, [WATCHLIST_STORY_EVENT_TYPE]), event(['AAPL'])), false);
  });

  it('rule without the eventType not delivered — even with matching tickers', () => {
    assert.equal(matchesWatchlist(rule(['AAPL'], []), event(['AAPL'])), false);
    assert.equal(matchesWatchlist(rule(['AAPL'], ['rss_alert']), event(['AAPL'])), false);
  });

  it('event without tickers never delivers to a scoped rule', () => {
    assert.equal(matchesWatchlist(rule(['AAPL']), event([])), false);
    assert.equal(matchesWatchlist(rule(['AAPL']), event(undefined)), false);
  });

  it('intersection is case-insensitive (defensive against unnormalized rows)', () => {
    assert.equal(matchesWatchlist(rule(['aapl']), event(['AAPL'])), true);
  });

  it('non-watchlist events pass the ticker filter untouched', () => {
    const rss = { eventType: 'rss_alert', payload: { title: 'x' } };
    assert.equal(eventMatchesTickerScope(rss, rule([], [])), true);
    assert.equal(eventMatchesTickerScope(rss, {}), true);
  });

  it("wildcard rule (eventTypes: []) still matches broadcast types but NOT watchlist events", () => {
    const rss = { eventType: 'rss_alert', payload: { title: 'x' } };
    assert.equal(ruleMatchesEventType({ eventTypes: [] }, rss), true);
    assert.equal(ruleMatchesEventType({ eventTypes: [] }, event(['AAPL'])), false);
  });

  it("rule with eventTypes ['watchlist_story_alert'] KEEPS the broadcast wildcard (regression: opting in must not silence rss alerts)", () => {
    const rss = { eventType: 'rss_alert', payload: { title: 'x' } };
    const r = { eventTypes: [WATCHLIST_STORY_EVENT_TYPE] };
    assert.equal(ruleMatchesEventType(r, rss), true);
    assert.equal(ruleMatchesEventType(r, event(['AAPL'])), true);
  });

  it("rule with explicit broadcast list + watchlist opt-in restricts broadcast types to the list", () => {
    const r = { eventTypes: ['oref_siren', WATCHLIST_STORY_EVENT_TYPE] };
    assert.equal(ruleMatchesEventType(r, { eventType: 'oref_siren' }), true);
    assert.equal(ruleMatchesEventType(r, { eventType: 'rss_alert' }), false);
    assert.equal(ruleMatchesEventType(r, event(['AAPL'])), true);
  });
});

describe('tickers forwarding contract — API layers (mirror of the countries contract)', () => {
  it('Vercel edge set-alert-rules forwards tickers to the Convex relay', () => {
    assert.match(
      edgeSrc,
      /action === 'set-alert-rules'[\s\S]*?tickers[\s\S]*?convexRelay\(\{[\s\S]*?tickers/,
      'set-alert-rules must forward tickers',
    );
  });

  it('Convex HTTP set-alert-rules forwards tickers into setAlertRulesForUser', () => {
    assert.match(
      convexHttpSrc,
      /setAlertRulesForUser[\s\S]*?tickers:\s*Array\.isArray\(body\.tickers\)/,
      'setAlertRulesForUser call must include tickers',
    );
  });

  it('set-notification-config forwards tickers and rejects non-arrays at both layers', () => {
    assert.match(
      edgeSrc,
      /tickers\s*!==\s*undefined\s*&&\s*!Array\.isArray\(tickers\)[\s\S]*?TICKERS_MUST_BE_ARRAY/,
      'Vercel edge route must reject non-array tickers',
    );
    assert.match(
      convexHttpSrc,
      /body\.tickers\s*!==\s*undefined\s*&&\s*!Array\.isArray\(body\.tickers\)[\s\S]*?TICKERS_MUST_BE_ARRAY/,
      'Convex HTTP route must reject non-array tickers',
    );
    assert.match(
      convexHttpSrc,
      /setNotificationConfigForUser[\s\S]*?tickers:\s*Array\.isArray\(body\.tickers\)/,
      'setNotificationConfigForUser call must include tickers',
    );
  });

  it('convex/alertRules.ts normalizes tickers on write (normalizeTickers, TICKERS_MAX=50)', () => {
    assert.match(convexRulesSrc, /function normalizeTickers\(input: string\[\]\): string\[\]/);
    assert.match(convexRulesSrc, /const TICKERS_MAX = 50/);
    // Shape must accept every non-index shared/stocks.json symbol
    // (RELIANCE.NS 8-char base, BRK-B, M&M.NS) — see alertRules-tickers
    // convex test for the behavioural matrix.
    assert.match(convexRulesSrc, /\^\[A-Z\]\[A-Z0-9&-\]\{0,11\}\(\\\.\[A-Z\]\{1,3\}\)\?\$/);
  });
});
