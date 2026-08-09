// The /api/health `tradeFlows` gate, driven through the REAL classifier.
//
// This entry exists to make one distinction observable (issue #6309): a flow
// fleet that seeded fewer reporters than it should reads COVERAGE_PARTIAL,
// while a seeder that stopped reads STALE_SEED. Both were previously invisible
// — the fleet had no health registration at all.
//
// An alarm nobody tested is an alarm that can be green while the thing it
// watches is dead, so every arm below is asserted, including the one that must
// NOT fire.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __testing__ } from '../api/health.js';
import { TRADE_FLOW_META_KEY, TRADE_TTL } from '../scripts/seed-supply-chain-trade.mjs';

const { classifyKey, STANDALONE_KEYS, SEED_META, ROLLOUT_PENDING_UNTIL_MS } = __testing__;

test('the producer and health agree on the meta key, value-to-value', () => {
  // Three independently-typed copies of this string: the seeder writes it,
  // health probes it, and health reads its freshness from it. Nothing else
  // couples them, so a rename on one side would silently un-monitor the fleet
  // while every suite stayed green. Same pin the comtrade sibling carries.
  assert.equal(STANDALONE_KEYS.tradeFlows, TRADE_FLOW_META_KEY);
  assert.equal(SEED_META.tradeFlows.key, TRADE_FLOW_META_KEY);
});

const NOW = 1_700_000_000_000;
const ONE_MIN_MS = 60_000;
const KEY = STANDALONE_KEYS.tradeFlows;
const META = SEED_META.tradeFlows.key;

// The meta record IS the probe target for this fleet: payloads are sharded one
// key per reporter, so health watches the aggregate rather than electing one
// reporter to stand for all of them.
function classifyAt(now, { ageMin = 1, recordCount = 256, present = true } = {}) {
  return classifyKey(
    'tradeFlows',
    KEY,
    {},
    {
      keyStrens: new Map(present ? [[KEY, 4096]] : []),
      keyErrors: new Map(),
      keyMetaValues: new Map(present
        ? [[META, JSON.stringify({ fetchedAt: now - ageMin * ONE_MIN_MS, recordCount })]]
        : []),
      keyMetaErrors: new Map(),
      now,
    },
  );
}

function classifyWithMeta(meta, { ageMin = 1, recordCount = 256, present = true } = {}) {
  return classifyKey(
    'tradeFlows',
    KEY,
    {},
    {
      keyStrens: new Map(present ? [[KEY, 4096]] : []),
      keyErrors: new Map(),
      keyMetaValues: new Map(present
        ? [[META, JSON.stringify({ fetchedAt: STRICT_NOW - ageMin * ONE_MIN_MS, recordCount, ...meta })]]
        : []),
      keyMetaErrors: new Map(),
      now: STRICT_NOW,
    },
  );
}

// Default clock sits past the deploy-window grace so the ordinary arms below
// exercise the strict behavior, not the rollout softening.
const STRICT_NOW = Math.max(NOW, (__testing__.ROLLOUT_PENDING_UNTIL_MS?.tradeFlows ?? 0) + 86_400_000);
const classify = (over) => classifyAt(STRICT_NOW, over);

test('a healthy run reads OK', () => {
  // 256 pairs is what production held on 2026-08-07, the measurement the floor
  // was derived from. If this ever reddens, the floor outgrew reality.
  assert.equal(classify({ recordCount: 256 }).status, 'OK');
});

test('a shortfall in seeded reporters reads COVERAGE_PARTIAL, not OK', () => {
  const entry = classify({ recordCount: 150 });
  assert.equal(entry.status, 'COVERAGE_PARTIAL');
  assert.equal(entry.records, 150, 'the count operators triage from must be on the wire');
});

test('the floor is reachable from both sides', () => {
  // A threshold no realistic value can cross is not a threshold. Pin the exact
  // boundary so a future edit cannot quietly move it out of reach.
  assert.equal(classify({ recordCount: SEED_META.tradeFlows.minRecordCount }).status, 'OK');
  assert.equal(classify({ recordCount: SEED_META.tradeFlows.minRecordCount - 1 }).status, 'COVERAGE_PARTIAL');
});

test('a stopped seeder reads STALE_SEED, and outranks a coverage shortfall', () => {
  const stale = SEED_META.tradeFlows.maxStaleMin + 1;
  assert.equal(classify({ ageMin: stale }).status, 'STALE_SEED');
  assert.equal(classify({ ageMin: stale, recordCount: 10 }).status, 'STALE_SEED',
    'a dead seeder is the cause; its shrunken count is the symptom');
});

test('the staleness budget fires before the data keys it vouches for expire', () => {
  // This is a META-ONLY probe: STANDALONE_KEYS.tradeFlows IS the seed-meta key,
  // because the payload is sharded per reporter. So the hasData/EMPTY backstop
  // watches the meta record (7-day TTL from writeSeedMeta), never the 8h data
  // keys — nothing else would notice them expiring. The budget must therefore
  // land INSIDE the data TTL, the opposite of a probe that watches a real data
  // key. Getting this backwards opens a silent window where every flow key is
  // gone and health still reads OK.
  // Derived from the producer's own constant, not a copy of it: a hardcoded 480
  // would keep this green if TRADE_TTL moved, which is exactly the drift this
  // invariant exists to catch.
  const TRADE_TTL_MIN = TRADE_TTL / 60;
  const CRON_MIN = 360; // 6h
  assert.ok(SEED_META.tradeFlows.maxStaleMin < TRADE_TTL_MIN,
    `maxStaleMin ${SEED_META.tradeFlows.maxStaleMin} must fire before the ${TRADE_TTL_MIN}min data TTL lapses`);
  assert.ok(SEED_META.tradeFlows.maxStaleMin > CRON_MIN,
    'and must clear the cron cadence, or an ordinary on-time run reads stale');

  assert.equal(classify({ ageMin: SEED_META.tradeFlows.maxStaleMin - 1 }).status, 'OK');
  assert.equal(classify({ ageMin: TRADE_TTL_MIN - 1 }).status, 'STALE_SEED',
    'the moment just before the data expires must already be alarming');
});

test('a vanished fleet is not reported as healthy', () => {
  const entry = classify({ present: false });
  assert.notEqual(entry.status, 'OK');
});

test('a coverage shortfall carries a dominantFailureMode on the entry', () => {
  // #6323: the whole point is an on-call agent can tell a transient WTO outage
  // from a permanent reporter-roster shift at a glance on /api/health. The mode
  // must ride on COVERAGE_PARTIAL itself — not only on the fault verdict —
  // because that is precisely the "healthy-looking partial" case it exists to
  // explain.
  const entry = classifyWithMeta(
    { dominantFailureMode: 'upstream' },
    { ageMin: 0, recordCount: 150, present: true },
  );
  assert.equal(entry.status, 'COVERAGE_PARTIAL', 'the shortfall still reads partial');
  assert.equal(entry.dominantFailureMode, 'upstream', 'the dominant cause must be relayed');
});

test('the absent-fleet alarm is not softened by any exemption list', () => {
  // `seed-meta:trade:flows` is new, so between merge and the first 6-hourly run
  // this key genuinely does not exist and health reports EMPTY. That verdict is
  // TRUE, not a false alarm — the v2 fleet really has not been written yet, and
  // the handler serves from the v1 bridge meanwhile — so it is deliberately left
  // to self-heal on the first run rather than softened.
  //
  // Both softening routes were considered and rejected: EMPTY_DATA_OK_KEYS is
  // permanent and would blunt the very alarm this issue added, and
  // ROLLOUT_PENDING_UNTIL_MS is a reviewed exemption scoped to the
  // consumer-price coverage keys, with a teardown protocol that assumes the map
  // empties. This test pins that neither was used.
  assert.equal(ROLLOUT_PENDING_UNTIL_MS.tradeFlows, undefined,
    'tradeFlows must not join the consumer-price-scoped rollout registry');
  assert.ok(!__testing__.EMPTY_DATA_OK_KEYS?.has?.('tradeFlows'),
    'a permanent empty-data exemption would blunt the absent-fleet alarm forever');

  const entry = classify({ present: false });
  assert.notEqual(entry.status, 'OK');
  assert.notEqual(entry.status, 'ROLLOUT_PENDING');
});
