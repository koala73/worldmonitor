// Tests for the Regional Intelligence regime-drift history recorder
// (Phase 3 PR1). Pure-function + injectable-ops unit tests; no Redis
// dependency. Run via:
//   npm run test:data

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTransitionEntry,
  publishTransitionWithOps,
  recordRegimeTransition,
  REGIME_HISTORY_KEY_PREFIX,
  REGIME_HISTORY_MAX,
} from '../scripts/regional-snapshot/regime-history.mjs';

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const menaRegion = { id: 'mena', label: 'Middle East & North Africa' };

function snapshotFixture(overrides = {}) {
  return {
    region_id: 'mena',
    generated_at: 1_700_000_000_000,
    meta: {
      snapshot_id: 'snap-mena-1',
      model_version: '0.1.0',
      scoring_version: '1.0.0',
      geography_version: '1.0.0',
      snapshot_confidence: 0.9,
      missing_inputs: [],
      stale_inputs: [],
      valid_until: 0,
      trigger_reason: 'regime_shift',
      narrative_provider: '',
      narrative_model: '',
    },
    regime: {
      label: 'coercive_stalemate',
      previous_label: 'calm',
      transitioned_at: 1_700_000_000_000,
      transition_driver: 'cross_source_surge',
    },
    balance: {},
    actors: [],
    leverage_edges: [],
    scenario_sets: [],
    transmission_paths: [],
    triggers: { active: [], watching: [], dormant: [] },
    mobility: { airspace: [], flight_corridors: [], airports: [], reroute_intensity: 0, notam_closures: [] },
    evidence: [],
    narrative: {
      situation: { text: '', evidence_ids: [] },
      balance_assessment: { text: '', evidence_ids: [] },
      outlook_24h: { text: '', evidence_ids: [] },
      outlook_7d: { text: '', evidence_ids: [] },
      outlook_30d: { text: '', evidence_ids: [] },
      watch_items: [],
    },
    ...overrides,
  };
}

function emptyDiff(overrides = {}) {
  return {
    regime_changed: null,
    scenario_jumps: [],
    trigger_activations: [],
    trigger_deactivations: [],
    corridor_breaks: [],
    leverage_shifts: [],
    buffer_failures: [],
    reroute_waves: null,
    mobility_disruptions: [],
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// buildTransitionEntry
// ────────────────────────────────────────────────────────────────────────────

describe('buildTransitionEntry', () => {
  it('returns null when diff has no regime_changed', () => {
    assert.equal(buildTransitionEntry(menaRegion, snapshotFixture(), emptyDiff()), null);
  });

  it('returns null for missing region or snapshot or diff', () => {
    assert.equal(buildTransitionEntry(null, snapshotFixture(), emptyDiff()), null);
    assert.equal(buildTransitionEntry(menaRegion, null, emptyDiff()), null);
    assert.equal(buildTransitionEntry(menaRegion, snapshotFixture(), null), null);
  });

  it('builds an entry when diff has regime_changed', () => {
    const diff = emptyDiff({ regime_changed: { from: 'calm', to: 'coercive_stalemate' } });
    const entry = buildTransitionEntry(menaRegion, snapshotFixture(), diff);
    assert.ok(entry);
    assert.equal(entry.region_id, 'mena');
    assert.equal(entry.label, 'coercive_stalemate');
    assert.equal(entry.previous_label, 'calm');
    assert.equal(entry.transitioned_at, 1_700_000_000_000);
    assert.equal(entry.transition_driver, 'cross_source_surge');
    assert.equal(entry.snapshot_id, 'snap-mena-1');
  });

  it('handles first-ever transition (previous_label empty)', () => {
    const diff = emptyDiff({ regime_changed: { from: '', to: 'coercive_stalemate' } });
    const entry = buildTransitionEntry(menaRegion, snapshotFixture(), diff);
    assert.equal(entry.previous_label, '');
    assert.equal(entry.label, 'coercive_stalemate');
  });

  it('returns null when regime_changed.to is missing', () => {
    const diff = emptyDiff({ regime_changed: { from: 'calm', to: '' } });
    assert.equal(buildTransitionEntry(menaRegion, snapshotFixture(), diff), null);
  });

  it('falls back to generated_at when regime.transitioned_at is missing', () => {
    const snap = snapshotFixture({
      regime: { label: 'coercive_stalemate', previous_label: 'calm', transitioned_at: 0, transition_driver: '' },
    });
    const diff = emptyDiff({ regime_changed: { from: 'calm', to: 'coercive_stalemate' } });
    const entry = buildTransitionEntry(menaRegion, snap, diff);
    assert.equal(entry.transitioned_at, snap.generated_at);
  });

  it('preserves snapshot_id so callers can join back to the full snapshot', () => {
    const snap = snapshotFixture({ meta: { ...snapshotFixture().meta, snapshot_id: 'custom-id-42' } });
    const diff = emptyDiff({ regime_changed: { from: 'calm', to: 'escalation_ladder' } });
    const entry = buildTransitionEntry(menaRegion, snap, diff);
    assert.equal(entry.snapshot_id, 'custom-id-42');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// publishTransitionWithOps — Redis orchestration
// ────────────────────────────────────────────────────────────────────────────

describe('publishTransitionWithOps', () => {
  /** Minimal in-memory Redis list simulator. */
  function memoryOps({ lpushFails = false, ltrimFails = false, lpushThrows = false, ltrimThrows = false } = {}) {
    /** @type {Record<string, string[]>} */
    const lists = {};
    /** @type {Array<{ op: string, key: string, args: any[] }>} */
    const calls = [];
    const ops = {
      lpush: async (key, value) => {
        calls.push({ op: 'lpush', key, args: [value] });
        if (lpushThrows) throw new Error('lpush blown up');
        if (lpushFails) return false;
        if (!lists[key]) lists[key] = [];
        lists[key].unshift(value); // LPUSH writes to head
        return true;
      },
      ltrim: async (key, start, stop) => {
        calls.push({ op: 'ltrim', key, args: [start, stop] });
        if (ltrimThrows) throw new Error('ltrim blown up');
        if (ltrimFails) return false;
        if (!lists[key]) return true;
        lists[key] = lists[key].slice(start, stop + 1);
        return true;
      },
    };
    return { ops, lists, calls };
  }

  const sampleEntry = {
    region_id: 'mena',
    label: 'coercive_stalemate',
    previous_label: 'calm',
    transitioned_at: 1_700_000_000_000,
    transition_driver: 'test',
    snapshot_id: 'snap-1',
  };

  it('happy path: LPUSH + LTRIM both succeed', async () => {
    const mem = memoryOps();
    const outcome = await publishTransitionWithOps(sampleEntry, mem.ops);
    assert.deepEqual(outcome, { pushed: true, trimmed: true });
    assert.equal(mem.calls.length, 2);
    assert.equal(mem.calls[0].op, 'lpush');
    assert.equal(mem.calls[1].op, 'ltrim');
  });

  it('writes to the canonical per-region key', async () => {
    const mem = memoryOps();
    await publishTransitionWithOps(sampleEntry, mem.ops);
    const expectedKey = `${REGIME_HISTORY_KEY_PREFIX}mena`;
    assert.equal(mem.calls[0].key, expectedKey);
    assert.ok(mem.lists[expectedKey]);
    assert.equal(mem.lists[expectedKey].length, 1);
    // Payload is JSON-encoded
    const parsed = JSON.parse(mem.lists[expectedKey][0]);
    assert.equal(parsed.label, 'coercive_stalemate');
  });

  it('LTRIM uses the REGIME_HISTORY_MAX cap', async () => {
    const mem = memoryOps();
    await publishTransitionWithOps(sampleEntry, mem.ops);
    const trimCall = mem.calls.find((c) => c.op === 'ltrim');
    assert.deepEqual(trimCall.args, [0, REGIME_HISTORY_MAX - 1]);
  });

  it('LPUSH failure: outcome reports not pushed, LTRIM not called', async () => {
    const mem = memoryOps({ lpushFails: true });
    const outcome = await publishTransitionWithOps(sampleEntry, mem.ops);
    assert.deepEqual(outcome, { pushed: false, trimmed: false });
    assert.equal(mem.calls.length, 1); // only lpush, no ltrim
  });

  it('LTRIM failure: outcome reports pushed but not trimmed (non-fatal)', async () => {
    const mem = memoryOps({ ltrimFails: true });
    const outcome = await publishTransitionWithOps(sampleEntry, mem.ops);
    assert.deepEqual(outcome, { pushed: true, trimmed: false });
    assert.equal(mem.calls.length, 2);
  });

  it('LPUSH throwing is caught and reported as non-pushed', async () => {
    const mem = memoryOps({ lpushThrows: true });
    const outcome = await publishTransitionWithOps(sampleEntry, mem.ops);
    assert.deepEqual(outcome, { pushed: false, trimmed: false });
  });

  it('LTRIM throwing is caught; pushed=true still reported', async () => {
    const mem = memoryOps({ ltrimThrows: true });
    const outcome = await publishTransitionWithOps(sampleEntry, mem.ops);
    assert.equal(outcome.pushed, true);
    assert.equal(outcome.trimmed, false);
  });

  it('returns not-pushed for a null/empty entry', async () => {
    const mem = memoryOps();
    assert.deepEqual(await publishTransitionWithOps(null, mem.ops), { pushed: false, trimmed: false });
    assert.deepEqual(await publishTransitionWithOps({}, mem.ops), { pushed: false, trimmed: false });
    assert.equal(mem.calls.length, 0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// recordRegimeTransition — end-to-end with injected publisher
// ────────────────────────────────────────────────────────────────────────────

describe('recordRegimeTransition', () => {
  function mockPublisher() {
    const calls = [];
    const publish = async (entry) => {
      calls.push(entry);
      return { pushed: true, trimmed: true };
    };
    return { publish, calls };
  }

  it('no-ops when diff has no regime change, publisher never called', async () => {
    const pub = mockPublisher();
    const result = await recordRegimeTransition(
      menaRegion,
      snapshotFixture(),
      emptyDiff(),
      { publishEntry: pub.publish },
    );
    assert.equal(result.recorded, false);
    assert.equal(result.entry, null);
    assert.equal(pub.calls.length, 0);
  });

  it('records on regime change and reports pushed=true', async () => {
    const pub = mockPublisher();
    const result = await recordRegimeTransition(
      menaRegion,
      snapshotFixture(),
      emptyDiff({ regime_changed: { from: 'calm', to: 'coercive_stalemate' } }),
      { publishEntry: pub.publish },
    );
    assert.equal(result.recorded, true);
    assert.ok(result.entry);
    assert.equal(result.entry.label, 'coercive_stalemate');
    assert.equal(pub.calls.length, 1);
  });

  it('returns recorded=false when publisher reports not pushed', async () => {
    const publish = async () => ({ pushed: false, trimmed: false });
    const result = await recordRegimeTransition(
      menaRegion,
      snapshotFixture(),
      emptyDiff({ regime_changed: { from: 'calm', to: 'escalation_ladder' } }),
      { publishEntry: publish },
    );
    assert.equal(result.recorded, false);
    assert.ok(result.entry); // entry was still built
  });

  it('swallows publisher exceptions and never throws', async () => {
    const publish = async () => {
      throw new Error('upstream blown up');
    };
    const result = await recordRegimeTransition(
      menaRegion,
      snapshotFixture(),
      emptyDiff({ regime_changed: { from: 'calm', to: 'escalation_ladder' } }),
      { publishEntry: publish },
    );
    assert.equal(result.recorded, false);
    assert.equal(result.pushed, false);
  });

  it('distinguishes critical escalation from calm (label preserved)', async () => {
    const pub = mockPublisher();
    await recordRegimeTransition(
      menaRegion,
      snapshotFixture(),
      emptyDiff({ regime_changed: { from: 'stressed_equilibrium', to: 'escalation_ladder' } }),
      { publishEntry: pub.publish },
    );
    assert.equal(pub.calls[0].label, 'escalation_ladder');
    assert.equal(pub.calls[0].previous_label, 'stressed_equilibrium');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Constants sanity
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// transition_driver backfill (PR #2981 review fix)
// ────────────────────────────────────────────────────────────────────────────

describe('transition_driver from snapshot.regime (PR #2981 P2 #1)', () => {
  it('carries a populated driver when the snapshot regime has one', () => {
    // After the fix, seed-regional-snapshots.mjs patches
    // regime.transition_driver = triggerReason after the diff step.
    // This test verifies the recorder reads it through correctly.
    const snap = snapshotFixture({
      regime: {
        label: 'escalation_ladder',
        previous_label: 'coercive_stalemate',
        transitioned_at: 1_700_000_000_000,
        transition_driver: 'regime_shift',
      },
    });
    const diff = emptyDiff({ regime_changed: { from: 'coercive_stalemate', to: 'escalation_ladder' } });
    const entry = buildTransitionEntry(menaRegion, snap, diff);
    assert.ok(entry);
    assert.equal(entry.transition_driver, 'regime_shift');
  });

  it('falls back to empty driver when the seed path is pre-fix (back-compat)', () => {
    // Pre-fix snapshots carry transition_driver='' from
    // buildRegimeState(balance, previousLabel, ''). The entry should
    // still record cleanly — just with empty driver.
    const snap = snapshotFixture({
      regime: {
        label: 'coercive_stalemate',
        previous_label: 'calm',
        transitioned_at: 1_700_000_000_000,
        transition_driver: '',
      },
    });
    const diff = emptyDiff({ regime_changed: { from: 'calm', to: 'coercive_stalemate' } });
    const entry = buildTransitionEntry(menaRegion, snap, diff);
    assert.ok(entry);
    assert.equal(entry.transition_driver, '');
  });
});

// ────────────────────────────────────────────────────────────────────────────

describe('module constants', () => {
  it('REGIME_HISTORY_KEY_PREFIX matches the handler read prefix', () => {
    assert.equal(REGIME_HISTORY_KEY_PREFIX, 'intelligence:regime-history:v1:');
  });

  it('REGIME_HISTORY_MAX is a positive integer', () => {
    assert.ok(Number.isInteger(REGIME_HISTORY_MAX));
    assert.ok(REGIME_HISTORY_MAX > 0);
  });
});
