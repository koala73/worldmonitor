import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { __testing__ } from '../api/health.js';
import {
  MARKET_ALERT_ACTIVATION_KEY,
  MARKET_ALERT_LEDGER_KEY,
  MARKET_ALERT_SCORECARD_KEY,
  MARKET_ALERT_SCORECARD_META_KEY,
  MARKET_ALERT_SEED_META_KEY,
} from '../scripts/_market-alert-ledger.mjs';

const NOW = 1_790_000_000_000;
const CHECKS = {
  marketAlertLedger: { dataKey: MARKET_ALERT_LEDGER_KEY, metaKey: MARKET_ALERT_SEED_META_KEY },
  marketAlertScorecard: { dataKey: MARKET_ALERT_SCORECARD_KEY, metaKey: MARKET_ALERT_SCORECARD_META_KEY },
};

function classify(name, overrides) {
  return __testing__.classifyKey(name, CHECKS[name].dataKey, { allowOnDemand: true }, {
    keyStrens: new Map(),
    keyErrors: new Map(),
    keyMetaValues: new Map(),
    keyMetaErrors: new Map(),
    now: NOW,
    ...overrides,
  });
}

describe('market-alert ledger health registration (#8867)', () => {
  for (const [name, { dataKey, metaKey }] of Object.entries(CHECKS)) {
    it(`${name} is a standalone check bound to the seeder's keys and activation marker`, () => {
      assert.equal(__testing__.STANDALONE_KEYS[name], dataKey);
      assert.equal(__testing__.SEED_META[name].key, metaKey);
      assert.equal(__testing__.SEED_META[name].maxStaleMin, 30);
      assert.equal(__testing__.SEED_META[name].activationKey, MARKET_ALERT_ACTIVATION_KEY);
      assert.equal(__testing__.SEED_META[name].cutover.activationKey, MARKET_ALERT_ACTIVATION_KEY);
      assert.equal(__testing__.ACTIVATION_MARKERS[name], MARKET_ALERT_ACTIVATION_KEY);
      assert.ok(__testing__.EMPTY_DATA_OK_KEYS.has(name));
    });

    it(`${name} reports OK for a fresh empty publish`, () => {
      const entry = classify(name, {
        keyStrens: new Map([[dataKey, 120]]),
        keyMetaValues: new Map([[metaKey, JSON.stringify({ fetchedAt: NOW - 60_000, recordCount: 0 })]]),
      });
      assert.equal(entry.status, 'OK');
    });

    it(`${name} never reports a critical status before the first publish`, () => {
      const entry = classify(name, {});
      assert.notEqual(__testing__.STATUS_COUNTS[entry.status], 'crit');
    });

    it(`${name} reports STALE_SEED once the 30-minute gate passes`, () => {
      const entry = classify(name, {
        keyStrens: new Map([[dataKey, 120]]),
        keyMetaValues: new Map([[metaKey, JSON.stringify({ fetchedAt: NOW - 31 * 60_000, recordCount: 3 })]]),
      });
      assert.equal(entry.status, 'STALE_SEED');
    });
  }
});
