/**
 * Bounded live checks for the official TPS Open Data source contracts.
 *
 * Run with LIVE_TPS_OPEN_DATA_TESTS=1. The default test suite skips this file's
 * network work so external availability does not affect deterministic CI.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  TPS_CALLS_PAGE_CAP,
  TPS_CALLS_SERVICE_ITEM_ID,
  TPS_DEFAULT_CALLS_MAX_PAGES,
  TPS_MCI_PAGE_CAP,
  TPS_MCI_SERVICE_ITEM_ID,
  fetchTpsCallsAttended,
  fetchTpsMci,
} from '../scripts/lib/tps-open-data.mjs';

const LIVE = process.env.LIVE_TPS_OPEN_DATA_TESTS === '1';
const FIXED_NOW = Date.UTC(2026, 8, 3);

function failureMessage(source, result) {
  return `${source}: ${result.reason || 'unknown failure'}${result.status ? ` (${result.status})` : ''}`;
}

describe(`TPS Open Data live contracts (${LIVE ? 'ENABLED' : 'SKIPPED - set LIVE_TPS_OPEN_DATA_TESTS=1'})`, { skip: !LIVE }, () => {
  it('fetches a complete multi-page MCI snapshot without an oversized GET URL', { timeout: 120_000 }, async () => {
    const result = await fetchTpsMci({
      now: FIXED_NOW,
      lookbackDays: 90,
      pageSize: TPS_MCI_PAGE_CAP,
      maxPages: 3,
    });

    assert.equal(result.ok, true, failureMessage('mci', result));
    assert.equal(result.snapshot.catalogItem, TPS_MCI_SERVICE_ITEM_ID);
    assert.ok(result.snapshot.records.length > TPS_MCI_PAGE_CAP, 'mci: fixture window must exercise more than one page');
    assert.ok(result.snapshot.records.length <= TPS_MCI_PAGE_CAP * 3, 'mci: bounded page budget exceeded');
    assert.equal(new Set(result.snapshot.records.map((row) => row.objectId)).size, result.snapshot.records.length);
  });

  it('discovers and fetches the current Toronto CKAN Calls datastore', { timeout: 120_000 }, async () => {
    const result = await fetchTpsCallsAttended({
      now: FIXED_NOW,
      pageSize: TPS_CALLS_PAGE_CAP,
      maxPages: TPS_DEFAULT_CALLS_MAX_PAGES,
    });

    assert.equal(result.ok, true, failureMessage('calls', result));
    assert.equal(result.snapshot.catalogItem, TPS_CALLS_SERVICE_ITEM_ID);
    assert.ok(result.snapshot.records.length > 0, 'calls: official datastore must not be empty');
    assert.ok(
      result.snapshot.records.length <= TPS_CALLS_PAGE_CAP * TPS_DEFAULT_CALLS_MAX_PAGES,
      'calls: bounded page budget exceeded',
    );
    assert.equal(new Set(result.snapshot.records.map((row) => row.objectId)).size, result.snapshot.records.length);
  });
});
