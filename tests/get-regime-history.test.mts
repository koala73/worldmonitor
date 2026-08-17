import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { adaptTransition } from '../server/worldmonitor/intelligence/v1/get-regime-history';
import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths.ts';

describe('adaptTransition', () => {
  it('maps all fields from persisted shape to proto shape', () => {
    const result = adaptTransition({
      region_id: 'mena',
      label: 'coercive_stalemate',
      previous_label: 'calm',
      transitioned_at: 1_700_000_000_000,
      transition_driver: 'cross_source_surge',
      snapshot_id: 'snap-mena-42',
    });
    assert.equal(result.regionId, 'mena');
    assert.equal(result.label, 'coercive_stalemate');
    assert.equal(result.previousLabel, 'calm');
    assert.equal(result.transitionedAt, 1_700_000_000_000);
    assert.equal(result.transitionDriver, 'cross_source_surge');
    assert.equal(result.snapshotId, 'snap-mena-42');
  });

  it('coerces missing optional fields to empty strings / zero', () => {
    const result = adaptTransition({ label: 'calm' });
    assert.equal(result.regionId, '');
    assert.equal(result.label, 'calm');
    assert.equal(result.previousLabel, '');
    assert.equal(result.transitionedAt, 0);
    assert.equal(result.transitionDriver, '');
    assert.equal(result.snapshotId, '');
  });

  it('preserves the first-ever transition shape (empty previous_label)', () => {
    const result = adaptTransition({
      region_id: 'east-asia',
      label: 'coercive_stalemate',
      previous_label: '',
      transitioned_at: 1_700_000_000_000,
    });
    assert.equal(result.previousLabel, '');
  });

  it('rejects non-numeric transitioned_at', () => {
    // Treat NaN / string input as 0 so proto int64 never sees garbage.
    const result = adaptTransition(/** @type any */ ({ transitioned_at: 'not a number' }));
    assert.equal(result.transitionedAt, 0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Handler structural checks (single-file handler discipline)
// ────────────────────────────────────────────────────────────────────────────

// The handler-internals, registration and proto assertions that used to close
// this file pinned import lines, Redis key literals and proto field numbers.
// Generated clients make an unregistered RPC a typecheck failure; adaptTransition
// above is the behaviour worth testing. The premium gate survives, asserted
// against the real Set rather than a grep of the module text.

describe('regime history is premium-gated', () => {
  it('is in PREMIUM_RPC_PATHS', () => {
    assert.ok(PREMIUM_RPC_PATHS.has('/api/intelligence/v1/get-regime-history'));
  });
});
