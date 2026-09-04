/**
 * Coverage for the passkey offer diagnostic trace
 * (`src/utils/passkey-offer-trace.ts`).
 *
 * Why this exists: when the offer does not appear, there is currently no way to
 * tell which gate stopped it. Reasoning by elimination from a later snapshot is
 * not proof — an empty ledger is equally consistent with a failed platform
 * probe, an overlay, a lost claim, or a failed dynamic import. This records the
 * actual outcome as it happens.
 *
 * The privacy constraint is the whole design. The vocabulary is CLOSED: only
 * fixed enum members are ever recorded. No account keys, Clerk ids, session
 * ids, raw errors, or credential data — any same-origin script can read this.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PASSKEY_OFFER_REASONS,
  getPasskeyOfferTrace,
  readPasskeyOfferTrace,
  recordPasskeyOfferReason,
  resetPasskeyOfferTrace,
  TRACE_LIMIT,
} from '../src/utils/passkey-offer-trace.ts';

function freshWindow(): Record<string, unknown> {
  const g = globalThis as unknown as { window?: Record<string, unknown> };
  g.window = {};
  resetPasskeyOfferTrace();
  return g.window;
}

describe('recordPasskeyOfferReason', () => {
  it('records a reason and exposes it as the latest', () => {
    freshWindow();
    recordPasskeyOfferReason('not-armed');
    assert.equal(readPasskeyOfferTrace()?.last, 'not-armed');
  });

  it('keeps the sequence in order, so the gate ordering is legible', () => {
    freshWindow();
    recordPasskeyOfferReason('signed-out-observed');
    recordPasskeyOfferReason('import-started');
    recordPasskeyOfferReason('mounted');
    assert.deepEqual(getPasskeyOfferTrace(), ['signed-out-observed', 'import-started', 'mounted']);
  });

  it('bounds the trace so a long session cannot grow it without limit', () => {
    freshWindow();
    for (let i = 0; i < TRACE_LIMIT + 10; i += 1) recordPasskeyOfferReason('not-armed');
    assert.equal(getPasskeyOfferTrace().length, TRACE_LIMIT);
  });

  it('never throws when there is no window (SSR, node test runners)', () => {
    const g = globalThis as unknown as { window?: Record<string, unknown> };
    const had = 'window' in g;
    const prev = g.window;
    delete g.window;
    try {
      assert.doesNotThrow(() => recordPasskeyOfferReason('mounted'));
      assert.deepEqual(getPasskeyOfferTrace(), []);
    } finally {
      if (had) g.window = prev;
    }
  });
});

describe('the closed vocabulary', () => {
  it('accepts every declared reason', () => {
    freshWindow();
    for (const reason of PASSKEY_OFFER_REASONS) {
      assert.doesNotThrow(() => recordPasskeyOfferReason(reason));
    }
    assert.equal(getPasskeyOfferTrace().length, PASSKEY_OFFER_REASONS.length);
  });

  it('drops anything outside the vocabulary rather than recording it', () => {
    // The guarantee that makes this safe to expose: a caller cannot smuggle an
    // account key, session id, or error message through as a "reason".
    freshWindow();
    recordPasskeyOfferReason('acct:9xk2m' as never);
    recordPasskeyOfferReason('user_2abcDEF' as never);
    assert.deepEqual(getPasskeyOfferTrace(), []);
    assert.equal(readPasskeyOfferTrace()?.last, undefined);
  });

  it('carries no free-form fields at all', () => {
    freshWindow();
    recordPasskeyOfferReason('already-offered');
    const state = readPasskeyOfferTrace() as Record<string, unknown>;
    // Only `last` and `trace` — adding a field here is how PII creeps in.
    assert.deepEqual(Object.keys(state).sort(), ['last', 'trace']);
    for (const entry of state.trace as string[]) {
      assert.ok(PASSKEY_OFFER_REASONS.includes(entry as never));
    }
  });
});
