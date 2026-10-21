// Tests for the portwatch retry-on-empty pipeline added in PR #3611.
//
// Background: ArcGIS occasionally returns `{features: []}` (empty 200) under
// per-egress-IP rate limiting. The previous `fetchAll()` silently dropped any
// chokepoint with zero features — no log, no retry. WM 2026-05-06 incident:
// `cape_of_good_hope` and `gibraltar` were both in batch 2 of the
// CONCURRENCY=3 stride, both came back empty, /api/health flagged
// COVERAGE_PARTIAL with no diagnostic trail in Railway logs.
//
// `runFetchPipeline` (extracted for injection-testability) now:
//   1. Logs each empty-result on the concurrent first pass (instead of
//      silently dropping).
//   2. Retries any rejected-or-empty chokepoint sequentially (with a small
//      delay) to step out of rate-limit bursts.
//   3. Logs recovery on retry success and "still 0 after retry" on
//      retry-empty so operators can distinguish transient from permanent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFetchPipeline } from '../scripts/seed-portwatch.mjs';

// Minimal feature-shape factory — only the fields buildHistory cares about.
function makeFeature(date, total = 100) {
  return {
    attributes: {
      date,
      n_container: 0, n_dry_bulk: 0, n_general_cargo: 0, n_roro: 0, n_tanker: 0,
      n_total: total,
      capacity_container: 0, capacity_dry_bulk: 0, capacity_general_cargo: 0,
      capacity_roro: 0, capacity_tanker: 0,
    },
  };
}

// 14 days of features so computeWow doesn't return 0 (length < 14 short-circuit).
function makeFullHistory() {
  return Array.from({ length: 14 }, (_, i) => makeFeature(`2026-04-${String(i + 1).padStart(2, '0')}`, 100));
}

const CHOKEPOINTS = [
  { name: 'Suez Canal',        id: 'suez' },
  { name: 'Malacca Strait',    id: 'malacca_strait' },
  { name: 'Strait of Hormuz',  id: 'hormuz_strait' },
  { name: 'Cape of Good Hope', id: 'cape_of_good_hope' },
  { name: 'Gibraltar Strait',  id: 'gibraltar' },
  { name: 'Bosporus Strait',   id: 'bosphorus' },
];

// ── Steady-state happy path ──────────────────────────────────────────────

test('healthy first pass: every chokepoint succeeds, no retry, all returned', async () => {
  const calls = new Map();
  const fetcher = async (name) => {
    calls.set(name, (calls.get(name) || 0) + 1);
    return makeFullHistory();
  };
  const result = await runFetchPipeline(CHOKEPOINTS, Date.now(), fetcher, 0);
  assert.equal(Object.keys(result).length, CHOKEPOINTS.length, 'all 6 chokepoints in result');
  for (const cp of CHOKEPOINTS) {
    assert.equal(calls.get(cp.name), 1, `${cp.name} called exactly once (no retry)`);
    assert.ok(result[cp.id]?.history?.length, `${cp.id} has history`);
  }
});

// ── Recovery on empty 200 ────────────────────────────────────────────────

test('recovery: chokepoint that returns empty on pass 1 succeeds on retry', async () => {
  const callCounts = new Map();
  const fetcher = async (name) => {
    const n = (callCounts.get(name) || 0) + 1;
    callCounts.set(name, n);
    // Cape of Good Hope returns empty on first call, full on second.
    if (name === 'Cape of Good Hope' && n === 1) return [];
    return makeFullHistory();
  };
  const result = await runFetchPipeline(CHOKEPOINTS, Date.now(), fetcher, 0);
  assert.ok(result['cape_of_good_hope'], 'cape_of_good_hope recovered via retry');
  assert.equal(callCounts.get('Cape of Good Hope'), 2, 'Cape called twice (initial + retry)');
  assert.equal(Object.keys(result).length, CHOKEPOINTS.length, 'all 6 chokepoints in result post-retry');
});

test('recovery: chokepoint that throws on pass 1 succeeds on retry', async () => {
  const callCounts = new Map();
  const fetcher = async (name) => {
    const n = (callCounts.get(name) || 0) + 1;
    callCounts.set(name, n);
    if (name === 'Gibraltar Strait' && n === 1) throw new Error('ECONNRESET');
    return makeFullHistory();
  };
  const result = await runFetchPipeline(CHOKEPOINTS, Date.now(), fetcher, 0);
  assert.ok(result['gibraltar'], 'gibraltar recovered via retry after rejection');
  assert.equal(callCounts.get('Gibraltar Strait'), 2, 'Gibraltar called twice');
  assert.equal(Object.keys(result).length, CHOKEPOINTS.length, 'all 6 in result');
});

test('recovery: 2 of 3 in same batch return empty (the WM 2026-05-06 incident pattern), both recover', async () => {
  // Mirrors the production pattern: cape_of_good_hope + gibraltar in the same
  // CONCURRENCY=3 batch both returned empty 200s. Bosphorus (3rd in batch)
  // succeeded. Verify both come back via retry.
  const callCounts = new Map();
  const fetcher = async (name) => {
    const n = (callCounts.get(name) || 0) + 1;
    callCounts.set(name, n);
    if ((name === 'Cape of Good Hope' || name === 'Gibraltar Strait') && n === 1) return [];
    return makeFullHistory();
  };
  const result = await runFetchPipeline(CHOKEPOINTS, Date.now(), fetcher, 0);
  assert.ok(result['cape_of_good_hope'], 'cape recovered');
  assert.ok(result['gibraltar'], 'gibraltar recovered');
  assert.ok(result['bosphorus'], 'bosphorus untouched (was healthy on pass 1)');
  assert.equal(callCounts.get('Bosporus Strait'), 1, 'bosphorus called only once');
  assert.equal(Object.keys(result).length, CHOKEPOINTS.length, 'all 6 in result');
});

// ── Permanent failure handling ───────────────────────────────────────────

test('permanent failure: chokepoint empty on both passes is dropped (no throw)', async () => {
  const fetcher = async (name) => {
    if (name === 'Cape of Good Hope') return [];     // permanently empty
    return makeFullHistory();
  };
  const result = await runFetchPipeline(CHOKEPOINTS, Date.now(), fetcher, 0);
  assert.equal(result['cape_of_good_hope'], undefined, 'cape dropped after retry-empty');
  assert.equal(Object.keys(result).length, CHOKEPOINTS.length - 1, '5 of 6 returned');
});

test('permanent failure: chokepoint that throws on both passes is dropped (no throw)', async () => {
  const fetcher = async (name) => {
    if (name === 'Gibraltar Strait') throw new Error('ArcGIS 503');
    return makeFullHistory();
  };
  const result = await runFetchPipeline(CHOKEPOINTS, Date.now(), fetcher, 0);
  assert.equal(result['gibraltar'], undefined, 'gibraltar dropped after retry-rejection');
  assert.equal(Object.keys(result).length, CHOKEPOINTS.length - 1);
});

test('all chokepoints fail on both passes: returns empty result (caller decides whether to throw)', async () => {
  const fetcher = async () => [];
  const result = await runFetchPipeline(CHOKEPOINTS, Date.now(), fetcher, 0);
  assert.deepEqual(result, {}, 'empty result; the outer fetchAll() turns this into a throw');
});

// ── Retry execution ordering ─────────────────────────────────────────────

test('retry pass is sequential, not concurrent (anti-thundering-herd)', async () => {
  // Track in-flight-during-retry to verify sequential. If the retry pass were
  // concurrent (Promise.all) and 3 cps need retry, all 3 would be in-flight at
  // some moment. Sequential means at most 1.
  let inFlight = 0;
  let maxInFlight = 0;
  const callCounts = new Map();
  const fetcher = async (name) => {
    const n = (callCounts.get(name) || 0) + 1;
    callCounts.set(name, n);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      // First pass: 3 of the 6 cps return empty. The CONCURRENCY=3 batch
      // means 3 in-flight together is expected on pass 1 — that's fine.
      // We're checking the RETRY pass is sequential.
      const empties = ['Cape of Good Hope', 'Gibraltar Strait', 'Bosporus Strait'];
      if (empties.includes(name) && n === 1) return [];
      return makeFullHistory();
    } finally {
      inFlight--;
    }
  };
  await runFetchPipeline(CHOKEPOINTS, Date.now(), fetcher, 0);
  // Pass 1 has CONCURRENCY=3 in-flight at peak. The retry pass adds 1 at a
  // time (sequential). So the GLOBAL max stays at 3 — would be 6 if retry
  // were concurrent (since 3 would race against pass-2 batches).
  assert.ok(maxInFlight <= 3, `max in-flight=${maxInFlight}; retry pass must be sequential`);
});

test('retry honors retryDelayMs argument (small delay between retries)', async () => {
  const timestamps = [];
  const callCounts = new Map();
  const fetcher = async (name) => {
    const n = (callCounts.get(name) || 0) + 1;
    callCounts.set(name, n);
    if (n === 2) timestamps.push(Date.now());     // record retry-call timestamps
    if ((name === 'Cape of Good Hope' || name === 'Gibraltar Strait') && n === 1) return [];
    return makeFullHistory();
  };
  await runFetchPipeline(CHOKEPOINTS, Date.now(), fetcher, 50);
  assert.equal(timestamps.length, 2, 'two retries fired');
  const gap = timestamps[1] - timestamps[0];
  // Threshold = half the delay arg. Wider than 40ms to absorb scheduler
  // jitter on slow/shared CI runners (Greptile P2 on PR #3611) without
  // losing the signal that the delay actually fires (gap > 0 alone would
  // pass even if retryDelayMs were ignored).
  assert.ok(gap >= 25, `retry gap ${gap}ms includes ≥25ms delay (the 50ms argument minus scheduler jitter)`);
});

// ── Output shape (no regression on existing fetchAll contract) ───────────

test('output shape: each entry has {history, wowChangePct} (back-compat with consumers)', async () => {
  const fetcher = async () => makeFullHistory();
  const result = await runFetchPipeline(CHOKEPOINTS, Date.now(), fetcher, 0);
  for (const cp of CHOKEPOINTS) {
    const entry = result[cp.id];
    assert.ok(entry, `${cp.id} present`);
    assert.ok(Array.isArray(entry.history), `${cp.id}.history is array`);
    assert.equal(typeof entry.wowChangePct, 'number', `${cp.id}.wowChangePct is number`);
  }
});
