import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWatchlistTickerSyncPayload,
  type AlertRule,
} from '../src/services/notification-channels.ts';

const baseRule: AlertRule = {
  variant: 'finance',
  enabled: true,
  eventTypes: ['watchlist_story_alert'],
  sensitivity: 'high',
  channels: ['email'],
  quietHoursEnabled: true,
  aiDigestEnabled: true,
  countries: ['US'],
  tickers: ['OLD'],
};

describe('buildWatchlistTickerSyncPayload', () => {
  it('returns null when the rule is missing, disabled, or not opted into watchlist stories', () => {
    assert.equal(buildWatchlistTickerSyncPayload(undefined, ['AAPL']), null);
    assert.equal(buildWatchlistTickerSyncPayload({ ...baseRule, enabled: false }, ['AAPL']), null);
    assert.equal(buildWatchlistTickerSyncPayload({ ...baseRule, eventTypes: ['rss_alert'] }, ['AAPL']), null);
  });

  it('builds the preserve-on-omit alert-rule payload with the normalized ticker scope', () => {
    const payload = buildWatchlistTickerSyncPayload(baseRule, [' aapl ', 'MSFT', 'MSFT', '^GSPC']);

    assert.deepEqual(payload, {
      variant: 'finance',
      enabled: true,
      eventTypes: ['watchlist_story_alert'],
      sensitivity: 'high',
      channels: ['email'],
      tickers: ['AAPL', 'MSFT'],
    });
    assert.equal(Object.hasOwn(payload!, 'countries'), false);
    assert.equal(Object.hasOwn(payload!, 'aiDigestEnabled'), false);
  });

  it('returns null when the normalized ticker scope is already current', () => {
    assert.equal(
      buildWatchlistTickerSyncPayload({ ...baseRule, tickers: ['aapl', 'MSFT'] }, [' AAPL ', 'MSFT', 'MSFT', '^GSPC']),
      null,
    );
  });

  it('returns null for reorder-only ticker scope changes', () => {
    assert.equal(
      buildWatchlistTickerSyncPayload({ ...baseRule, tickers: ['MSFT', 'aapl'] }, [' AAPL ', 'MSFT', 'MSFT', '^GSPC']),
      null,
    );
  });
});
