// Tests for the Regional Intelligence state-change alert emitter (Phase 2 PR1).
// Pure-function + injectable-publisher unit tests; no network. Run via:
//   npm run test:data

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAlertEvents,
  buildDedupKey,
  simpleHash,
  emitRegionalAlerts,
  publishEventWithOps,
} from '../scripts/regional-snapshot/alert-emitter.mjs';

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const menaRegion = { id: 'mena', label: 'Middle East & North Africa' };
const eastAsiaRegion = { id: 'east-asia', label: 'East Asia & Pacific' };

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
      trigger_reason: 'scheduled_6h',
      narrative_provider: '',
      narrative_model: '',
    },
    regime: { label: 'coercive_stalemate', previous_label: 'calm', transitioned_at: 0, transition_driver: '' },
    balance: {
      coercive_pressure: 0.5,
      domestic_fragility: 0.5,
      capital_stress: 0.5,
      energy_vulnerability: 0.5,
      alliance_cohesion: 0.5,
      maritime_access: 0.5,
      energy_leverage: 0.5,
      net_balance: 0,
      pressures: [],
      buffers: [],
    },
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
// buildAlertEvents — pure event builder
// ────────────────────────────────────────────────────────────────────────────

describe('buildAlertEvents', () => {
  it('returns [] when the diff has no meaningful changes', () => {
    const events = buildAlertEvents(menaRegion, snapshotFixture(), emptyDiff());
    assert.deepEqual(events, []);
  });

  it('emits a regime_shift event with high severity for non-critical labels', () => {
    const events = buildAlertEvents(
      menaRegion,
      snapshotFixture(),
      emptyDiff({ regime_changed: { from: 'calm', to: 'coercive_stalemate' } }),
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'regional_regime_shift');
    assert.equal(events[0].severity, 'high');
    assert.match(events[0].payload.title, /calm → coercive stalemate/);
    assert.equal(events[0].payload.region_id, 'mena');
    assert.equal(events[0].payload.snapshot_id, 'snap-mena-1');
  });

  it('marks regime_shift critical when target is escalation_ladder', () => {
    const events = buildAlertEvents(
      menaRegion,
      snapshotFixture(),
      emptyDiff({ regime_changed: { from: 'stressed_equilibrium', to: 'escalation_ladder' } }),
    );
    assert.equal(events[0].severity, 'critical');
  });

  it('marks regime_shift critical when target is fragmentation_risk', () => {
    const events = buildAlertEvents(
      menaRegion,
      snapshotFixture(),
      emptyDiff({ regime_changed: { from: 'calm', to: 'fragmentation_risk' } }),
    );
    assert.equal(events[0].severity, 'critical');
  });

  it('labels "none" when previous regime is empty (first snapshot)', () => {
    const events = buildAlertEvents(
      menaRegion,
      snapshotFixture(),
      emptyDiff({ regime_changed: { from: '', to: 'coercive_stalemate' } }),
    );
    assert.match(events[0].payload.title, /none → coercive stalemate/);
  });

  it('emits one trigger_activation event per activated trigger', () => {
    const events = buildAlertEvents(
      menaRegion,
      snapshotFixture(),
      emptyDiff({
        trigger_activations: [
          { id: 'mena_coercive_high', description: 'Coercive pressure crossed 0.7' },
          { id: 'hormuz_transit_drop', description: 'Transit volume fell 30%' },
        ],
      }),
    );
    assert.equal(events.length, 2);
    assert.equal(events[0].eventType, 'regional_trigger_activation');
    assert.equal(events[0].severity, 'high');
    assert.match(events[0].payload.title, /mena_coercive_high/);
    assert.equal(events[1].payload.details.trigger_id, 'hormuz_transit_drop');
  });

  it('trigger_activation with empty description still renders a clean title', () => {
    const events = buildAlertEvents(
      menaRegion,
      snapshotFixture(),
      emptyDiff({ trigger_activations: [{ id: 'raw_trigger', description: '' }] }),
    );
    assert.match(events[0].payload.title, /trigger raw_trigger/);
    assert.doesNotMatch(events[0].payload.title, /—$/); // no trailing em dash
  });

  it('emits one corridor_break event per break with critical severity', () => {
    const events = buildAlertEvents(
      menaRegion,
      snapshotFixture(),
      emptyDiff({
        corridor_breaks: [
          { corridor_id: 'aggregate', from: '0.80', to: '0.45' },
        ],
      }),
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'regional_corridor_break');
    assert.equal(events[0].severity, 'critical');
    assert.match(events[0].payload.title, /aggregate.*0\.80.*0\.45/);
  });

  it('emits one buffer_failure event per axis with high severity', () => {
    const events = buildAlertEvents(
      menaRegion,
      snapshotFixture(),
      emptyDiff({
        buffer_failures: [
          { axis: 'alliance_cohesion', from: 0.70, to: 0.40 },
          { axis: 'maritime_access', from: 0.90, to: 0.50 },
        ],
      }),
    );
    assert.equal(events.length, 2);
    assert.equal(events[0].eventType, 'regional_buffer_failure');
    assert.equal(events[0].severity, 'high');
    assert.match(events[0].payload.title, /alliance cohesion.*0\.70.*0\.40/);
  });

  it('skips scenario_jumps and leverage_shifts (intentionally not emitted)', () => {
    const events = buildAlertEvents(
      menaRegion,
      snapshotFixture(),
      emptyDiff({
        scenario_jumps: [{ horizon: '24h', lane: 'escalation', from: 0.2, to: 0.5 }],
        leverage_shifts: [{ actor_id: 'IR', from: 0.5, to: 0.8, delta: 0.3 }],
      }),
    );
    assert.deepEqual(events, []);
  });

  it('returns events in stable order: regime → triggers → corridors → buffers', () => {
    const events = buildAlertEvents(
      menaRegion,
      snapshotFixture(),
      emptyDiff({
        regime_changed: { from: 'calm', to: 'coercive_stalemate' },
        trigger_activations: [{ id: 'trig1', description: '' }],
        corridor_breaks: [{ corridor_id: 'hormuz', from: '0.9', to: '0.4' }],
        buffer_failures: [{ axis: 'alliance_cohesion', from: 0.7, to: 0.4 }],
      }),
    );
    assert.equal(events[0].eventType, 'regional_regime_shift');
    assert.equal(events[1].eventType, 'regional_trigger_activation');
    assert.equal(events[2].eventType, 'regional_corridor_break');
    assert.equal(events[3].eventType, 'regional_buffer_failure');
  });

  it('returns [] for null/undefined arguments (defensive)', () => {
    assert.deepEqual(buildAlertEvents(null, snapshotFixture(), emptyDiff()), []);
    assert.deepEqual(buildAlertEvents(menaRegion, null, emptyDiff()), []);
    assert.deepEqual(buildAlertEvents(menaRegion, snapshotFixture(), null), []);
  });

  it('carries region.label into the title verbatim', () => {
    const events = buildAlertEvents(
      eastAsiaRegion,
      snapshotFixture({ region_id: 'east-asia' }),
      emptyDiff({ regime_changed: { from: 'calm', to: 'coercive_stalemate' } }),
    );
    assert.ok(events[0].payload.title.startsWith('East Asia & Pacific:'));
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Dedup key derivation
// ────────────────────────────────────────────────────────────────────────────

describe('buildDedupKey + simpleHash', () => {
  it('produces the expected key shape', () => {
    const key = buildDedupKey({
      eventType: 'regional_regime_shift',
      payload: { title: 'MENA: regime calm → coercive stalemate' },
    });
    assert.match(key, /^wm:notif:scan-dedup:regional_regime_shift:[a-z0-9]+$/);
  });

  it('produces the same hash for the same title + eventType', () => {
    const a = buildDedupKey({ eventType: 'x', payload: { title: 'hello' } });
    const b = buildDedupKey({ eventType: 'x', payload: { title: 'hello' } });
    assert.equal(a, b);
  });

  it('produces different hashes for different titles', () => {
    const a = buildDedupKey({ eventType: 'x', payload: { title: 'one' } });
    const b = buildDedupKey({ eventType: 'x', payload: { title: 'two' } });
    assert.notEqual(a, b);
  });

  it('produces different hashes for the same title under different eventTypes', () => {
    const a = buildDedupKey({ eventType: 'x', payload: { title: 'hi' } });
    const b = buildDedupKey({ eventType: 'y', payload: { title: 'hi' } });
    assert.notEqual(a, b);
  });

  it('handles missing payload.title safely', () => {
    const key = buildDedupKey({ eventType: 'x', payload: {} });
    assert.match(key, /^wm:notif:scan-dedup:x:/);
  });

  it('simpleHash returns a non-empty base36 string for any input', () => {
    assert.ok(simpleHash('').length > 0);
    assert.ok(simpleHash('a').length > 0);
    assert.ok(simpleHash('a much longer input string').length > 0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// emitRegionalAlerts — integration with injected publisher
// ────────────────────────────────────────────────────────────────────────────

describe('emitRegionalAlerts', () => {
  function mockPublisher() {
    const calls = [];
    const publish = async (event) => {
      calls.push(event);
      return true;
    };
    return { publish, calls };
  }

  it('no-ops on an empty diff without calling the publisher', async () => {
    const pub = mockPublisher();
    const result = await emitRegionalAlerts(menaRegion, snapshotFixture(), emptyDiff(), {
      publishEvent: pub.publish,
    });
    assert.equal(result.enqueued, 0);
    assert.equal(result.events.length, 0);
    assert.equal(pub.calls.length, 0);
  });

  it('enqueues each event through the injected publisher', async () => {
    const pub = mockPublisher();
    const result = await emitRegionalAlerts(
      menaRegion,
      snapshotFixture(),
      emptyDiff({
        regime_changed: { from: 'calm', to: 'coercive_stalemate' },
        trigger_activations: [{ id: 'mena_coercive_high', description: 'x' }],
      }),
      { publishEvent: pub.publish },
    );
    assert.equal(result.enqueued, 2);
    assert.equal(pub.calls.length, 2);
    assert.equal(pub.calls[0].eventType, 'regional_regime_shift');
    assert.equal(pub.calls[1].eventType, 'regional_trigger_activation');
  });

  it('counts only successful enqueues when the publisher returns false', async () => {
    let n = 0;
    const publish = async () => {
      n += 1;
      return n === 1; // only the first succeeds
    };
    const result = await emitRegionalAlerts(
      menaRegion,
      snapshotFixture(),
      emptyDiff({
        regime_changed: { from: 'calm', to: 'coercive_stalemate' },
        buffer_failures: [{ axis: 'alliance_cohesion', from: 0.7, to: 0.4 }],
      }),
      { publishEvent: publish },
    );
    assert.equal(result.enqueued, 1);
    assert.equal(result.events.length, 2);
  });

  it('swallows publisher exceptions and continues the loop', async () => {
    let n = 0;
    const publish = async () => {
      n += 1;
      if (n === 1) throw new Error('upstream down');
      return true;
    };
    const result = await emitRegionalAlerts(
      menaRegion,
      snapshotFixture(),
      emptyDiff({
        regime_changed: { from: 'calm', to: 'coercive_stalemate' },
        trigger_activations: [{ id: 't1', description: '' }],
      }),
      { publishEvent: publish },
    );
    // First event threw, second succeeded → enqueued === 1
    assert.equal(result.enqueued, 1);
    assert.equal(result.events.length, 2);
  });

  it('returns empty result when region/snapshot/diff are missing', async () => {
    const pub = mockPublisher();
    const a = await emitRegionalAlerts(null, snapshotFixture(), emptyDiff(), { publishEvent: pub.publish });
    const b = await emitRegionalAlerts(menaRegion, null, emptyDiff(), { publishEvent: pub.publish });
    const c = await emitRegionalAlerts(menaRegion, snapshotFixture(), null, { publishEvent: pub.publish });
    for (const r of [a, b, c]) {
      assert.equal(r.enqueued, 0);
      assert.deepEqual(r.events, []);
    }
    assert.equal(pub.calls.length, 0);
  });

  it('works end-to-end on a realistic escalation scenario', async () => {
    const pub = mockPublisher();
    const result = await emitRegionalAlerts(
      menaRegion,
      snapshotFixture(),
      emptyDiff({
        regime_changed: { from: 'stressed_equilibrium', to: 'escalation_ladder' },
        trigger_activations: [
          { id: 'mena_coercive_high', description: 'Coercive pressure > 0.7' },
          { id: 'hormuz_transit_drop', description: 'Transit volume < 70% baseline' },
        ],
        corridor_breaks: [{ corridor_id: 'hormuz', from: '0.90', to: '0.45' }],
        buffer_failures: [
          { axis: 'maritime_access', from: 0.90, to: 0.45 },
          { axis: 'alliance_cohesion', from: 0.70, to: 0.45 },
        ],
      }),
      { publishEvent: pub.publish },
    );
    assert.equal(result.enqueued, 6);
    // regime_shift should be critical (target = escalation_ladder)
    assert.equal(pub.calls[0].severity, 'critical');
    // corridor_break should always be critical
    const corridorEvent = pub.calls.find((e) => e.eventType === 'regional_corridor_break');
    assert.equal(corridorEvent.severity, 'critical');
    // Every event carries the same region_id + snapshot_id
    for (const ev of pub.calls) {
      assert.equal(ev.payload.region_id, 'mena');
      assert.equal(ev.payload.snapshot_id, 'snap-mena-1');
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// publishEventWithOps — dedup rollback on LPUSH failure (P1 fix for PR #2966)
// ────────────────────────────────────────────────────────────────────────────

describe('publishEventWithOps — dedup rollback', () => {
  /** Minimal in-memory Redis that tracks keys and the queue list. */
  function memoryOps({ lpushFails = false, setNxFails = false } = {}) {
    /** @type {Record<string, boolean>} */
    const dedupKeys = {};
    /** @type {string[]} */
    const queue = [];
    /** @type {string[]} */
    const deletedKeys = [];
    const ops = {
      setNx: async (key, _ttl) => {
        if (setNxFails) return false;
        if (dedupKeys[key]) return false;
        dedupKeys[key] = true;
        return true;
      },
      lpush: async (_key, value) => {
        if (lpushFails) return false;
        queue.push(value);
        return true;
      },
      del: async (key) => {
        delete dedupKeys[key];
        deletedKeys.push(key);
        return true;
      },
    };
    return { ops, dedupKeys, queue, deletedKeys };
  }

  const sampleEvent = {
    eventType: 'regional_regime_shift',
    severity: 'high',
    payload: { title: 'MENA: regime shift test' },
  };

  it('happy path: SET NX + LPUSH both succeed, no rollback', async () => {
    const mem = memoryOps();
    const outcome = await publishEventWithOps(sampleEvent, mem.ops);
    assert.deepEqual(outcome, { enqueued: true, dedupHit: false, rolledBack: false });
    assert.equal(mem.queue.length, 1);
    assert.equal(Object.keys(mem.dedupKeys).length, 1);
    assert.equal(mem.deletedKeys.length, 0);
  });

  it('dedup hit: returns dedupHit=true without touching the queue', async () => {
    const mem = memoryOps();
    // Pre-populate the dedup key so the second call hits it.
    mem.dedupKeys[buildDedupKey(sampleEvent)] = true;
    const outcome = await publishEventWithOps(sampleEvent, mem.ops);
    assert.deepEqual(outcome, { enqueued: false, dedupHit: true, rolledBack: false });
    assert.equal(mem.queue.length, 0);
    assert.equal(mem.deletedKeys.length, 0);
  });

  it('LPUSH failure: dedup key is rolled back via DEL', async () => {
    const mem = memoryOps({ lpushFails: true });
    const outcome = await publishEventWithOps(sampleEvent, mem.ops);
    assert.deepEqual(outcome, { enqueued: false, dedupHit: false, rolledBack: true });
    // Queue untouched...
    assert.equal(mem.queue.length, 0);
    // ...and dedup key was removed so next cycle can retry.
    assert.equal(Object.keys(mem.dedupKeys).length, 0);
    assert.equal(mem.deletedKeys.length, 1);
    assert.equal(mem.deletedKeys[0], buildDedupKey(sampleEvent));
  });

  it('retry-after-rollback: next call enqueues normally', async () => {
    // First call fails LPUSH and rolls back.
    const mem = memoryOps({ lpushFails: true });
    await publishEventWithOps(sampleEvent, mem.ops);
    assert.equal(Object.keys(mem.dedupKeys).length, 0);

    // Switch to a working LPUSH (new memory ops instance preserves dedup state).
    const retryOps = {
      setNx: mem.ops.setNx,
      lpush: async (_key, value) => {
        mem.queue.push(value);
        return true;
      },
      del: mem.ops.del,
    };
    const outcome = await publishEventWithOps(sampleEvent, retryOps);
    assert.equal(outcome.enqueued, true);
    assert.equal(mem.queue.length, 1);
  });

  it('LPUSH failure + DEL failure still returns rolledBack=true (best-effort)', async () => {
    const mem = memoryOps({ lpushFails: true });
    const opsWithBrokenDel = {
      setNx: mem.ops.setNx,
      lpush: mem.ops.lpush,
      del: async () => {
        throw new Error('del broke');
      },
    };
    const outcome = await publishEventWithOps(sampleEvent, opsWithBrokenDel);
    // We attempted rollback; del threw; still report rolledBack=true.
    assert.equal(outcome.rolledBack, true);
    assert.equal(outcome.enqueued, false);
  });

  it('swallows exceptions from setNx/lpush and returns a non-enqueued outcome', async () => {
    const brokenOps = {
      setNx: async () => {
        throw new Error('network blown up');
      },
      lpush: async () => true,
      del: async () => true,
    };
    const outcome = await publishEventWithOps(sampleEvent, brokenOps);
    assert.deepEqual(outcome, { enqueued: false, dedupHit: false, rolledBack: false });
  });
});
