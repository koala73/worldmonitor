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

// l10n PR 3 (#10884): brief-language lookup on the relay call.
describe('fetchUserPreferences brief language', () => {
  const modPath = require.resolve('../scripts/lib/user-context.cjs');
  async function withRelay(responseBody, fn, { ok = true } = {}) {
    const savedFetch = globalThis.fetch;
    const savedEnv = { CONVEX_SITE_URL: process.env.CONVEX_SITE_URL, CONVEX_NOTIFICATION_RELAY_SECRET: process.env.CONVEX_NOTIFICATION_RELAY_SECRET };
    process.env.CONVEX_SITE_URL = 'https://convex.test';
    process.env.CONVEX_NOTIFICATION_RELAY_SECRET = 'test-secret';
    delete require.cache[modPath];
    const bodies = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return { ok, status: ok ? 200 : 500, json: async () => responseBody };
    };
    try {
      const { fetchUserPreferences } = require(modPath);
      return await fn(fetchUserPreferences, bodies);
    } finally {
      globalThis.fetch = savedFetch;
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      delete require.cache[modPath];
    }
  }

  it('without the flag, posts { userId, variant } and returns the raw body', async () => {
    await withRelay({ watchlist: [] }, async (fetchUserPreferences, bodies) => {
      const out = await fetchUserPreferences('u1', 'full');
      assert.deepEqual(bodies[0], { userId: 'u1', variant: 'full' });
      assert.deepEqual(out, { data: { watchlist: [] }, error: false });
    });
  });

  it('with the flag, unwraps { data, briefLanguage }', async () => {
    await withRelay({ data: { watchlist: [] }, briefLanguage: 'fr' }, async (fetchUserPreferences, bodies) => {
      const out = await fetchUserPreferences('u1', 'full', { includeBriefLanguage: true, timeoutMs: 3000 });
      assert.deepEqual(bodies[0], { userId: 'u1', variant: 'full', includeBriefLanguage: true });
      assert.deepEqual(out, { data: { watchlist: [] }, error: false, briefLanguage: 'fr' });
    });
  });

  it('an old Convex response without briefLanguage reads as a legacy blob in English', async () => {
    await withRelay({ watchlist: ['x'] }, async (fetchUserPreferences) => {
      const out = await fetchUserPreferences('u1', 'full', { includeBriefLanguage: true });
      assert.deepEqual(out, { data: { watchlist: ['x'] }, error: false, briefLanguage: 'en' });
    });
  });

  it('an HTTP error still returns { data: null, error: true }', async () => {
    await withRelay({}, async (fetchUserPreferences) => {
      const out = await fetchUserPreferences('u1', 'full', { includeBriefLanguage: true });
      assert.equal(out.data, null);
      assert.equal(out.error, true);
    }, { ok: false });
  });
});
