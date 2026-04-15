import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractUserContext, formatUserProfile } = require('../scripts/lib/user-context.cjs');

// These helpers feed the digest AI executive summary prompt. The digest
// cron fetches userPreferences via a Convex relay endpoint that returns
// literal `null` when the (userId, variant) row doesn't exist. A user can
// have alertRules (with aiDigestEnabled: true) but no userPreferences
// document — for example, a notification rule enabled before the user
// ever synced the SPA, or under a different variant. Missing preferences
// MUST NOT silently disable the AI summary; we degrade to a generic
// "Variant: full" profile and still call the LLM.
//
// These tests lock in that contract so `extractUserContext(null)` and
// `formatUserProfile(ctx, variant)` remain null-safe.

describe('extractUserContext null-safety', () => {
  const empty = {
    tickers: [],
    airports: [],
    airlines: [],
    frameworkName: null,
    enabledPanels: [],
    disabledFeeds: [],
  };

  it('returns empty context for null', () => {
    assert.deepEqual(extractUserContext(null), empty);
  });

  it('returns empty context for undefined', () => {
    assert.deepEqual(extractUserContext(undefined), empty);
  });

  it('returns empty context for empty object', () => {
    assert.deepEqual(extractUserContext({}), empty);
  });

  it('returns empty context for non-object (string)', () => {
    assert.deepEqual(extractUserContext('not an object'), empty);
  });

  it('extracts tickers from wm-market-watchlist-v1', () => {
    const ctx = extractUserContext({
      'wm-market-watchlist-v1': [
        { symbol: 'AAPL' },
        { symbol: 'TSLA' },
        { notASymbol: true },
      ],
    });
    assert.deepEqual(ctx.tickers, ['AAPL', 'TSLA']);
  });

  it('extracts airports and airlines from aviation:watchlist:v1', () => {
    const ctx = extractUserContext({
      'aviation:watchlist:v1': {
        airports: ['JFK', 'LHR'],
        airlines: ['UAL', 'BA'],
      },
    });
    assert.deepEqual(ctx.airports, ['JFK', 'LHR']);
    assert.deepEqual(ctx.airlines, ['UAL', 'BA']);
  });
});

describe('formatUserProfile null-safety', () => {
  it('handles an entirely empty context (no crash, no empty lines)', () => {
    const emptyCtx = extractUserContext(null);
    const profile = formatUserProfile(emptyCtx, 'full');
    assert.equal(profile, 'Variant: full');
  });

  it('handles empty context for every variant value', () => {
    for (const variant of ['full', 'tech', 'finance', 'commodity', 'happy']) {
      const profile = formatUserProfile(extractUserContext(null), variant);
      assert.equal(profile, `Variant: ${variant}`);
    }
  });

  it('includes watchlist entries when present', () => {
    const ctx = extractUserContext({
      'wm-market-watchlist-v1': [{ symbol: 'AAPL' }, { symbol: 'TSLA' }],
    });
    const profile = formatUserProfile(ctx, 'finance');
    assert.match(profile, /^Variant: finance$/m);
    assert.match(profile, /^Watches: AAPL, TSLA$/m);
  });

  it('always includes the Variant line even with rich context', () => {
    const ctx = extractUserContext({
      'wm-market-watchlist-v1': [{ symbol: 'AAPL' }],
      'aviation:watchlist:v1': { airports: ['JFK'], airlines: ['UAL'] },
    });
    const profile = formatUserProfile(ctx, 'full');
    assert.match(profile, /^Variant: full$/m);
    assert.match(profile, /Watches: AAPL/);
    assert.match(profile, /Monitors airports: JFK/);
    assert.match(profile, /Monitors airlines: UAL/);
  });
});
