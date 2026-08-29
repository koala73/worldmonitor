/**
 * Coverage for the passkey offer ledger and mount decision
 * (`src/services/passkey-offer-state.ts`).
 *
 * The ledger is what makes "offer at most once per account" true. Three
 * properties here are the ones that break silently:
 *
 *   1. **The record is written at MOUNT, not at answer.** Anything else
 *      re-offers to a user who closed the tab with the prompt open.
 *   2. **Two tiers.** A throwing `localStorage` must not mean "remember
 *      nothing" — that re-offers on every auth cycle within the same page, so
 *      a storage-disabled browser nags forever. The in-memory tier is written
 *      BEFORE the persistent attempt, which is what makes it survive.
 *   3. **One key per account, opaque.** A shared key would need
 *      read-modify-write on every mount and would lose account isolation on a
 *      partial write. The raw Clerk id must never reach storage.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createOfferMemory,
  derivePasskeyAccountKey,
  hasBeenOffered,
  passkeyOfferStorageKey,
  recordOffered,
  shouldOfferPasskey,
} from '../src/services/passkey-offer-state.ts';

/** A localStorage stand-in whose failure modes are configurable per method. */
function makeStorage(opts: { throwOnGet?: boolean; throwOnSet?: boolean } = {}) {
  const data = new Map<string, string>();
  return {
    data,
    getItem(key: string): string | null {
      if (opts.throwOnGet) throw new Error('storage disabled');
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      if (opts.throwOnSet) throw new Error('quota exceeded');
      data.set(key, value);
    },
    removeItem(key: string): void {
      data.delete(key);
    },
  };
}

const KEY_A = derivePasskeyAccountKey('user_2abcDEF') as string;
const KEY_B = derivePasskeyAccountKey('user_9zyxWVU') as string;

describe('derivePasskeyAccountKey', () => {
  it('is stable for the same id and different for different ids', () => {
    assert.equal(derivePasskeyAccountKey('user_1'), derivePasskeyAccountKey('user_1'));
    assert.notEqual(derivePasskeyAccountKey('user_1'), derivePasskeyAccountKey('user_2'));
  });

  it('returns null for an absent or empty id', () => {
    assert.equal(derivePasskeyAccountKey(null), null);
    assert.equal(derivePasskeyAccountKey(undefined), null);
    assert.equal(derivePasskeyAccountKey(''), null);
  });

  it('never leaks the raw Clerk id — it must not reach origin-readable storage', () => {
    const raw = 'user_2abcDEFghiJKL';
    const key = derivePasskeyAccountKey(raw) as string;
    assert.ok(!key.includes(raw));
    assert.ok(!passkeyOfferStorageKey(key).includes(raw));
  });
});

describe('the persistent tier', () => {
  it('reads back an account as offered after recording it (AE6)', () => {
    const storage = makeStorage();
    const memory = createOfferMemory();
    assert.equal(hasBeenOffered(storage, memory, KEY_A), false);
    recordOffered(storage, memory, KEY_A);
    assert.equal(hasBeenOffered(storage, memory, KEY_A), true);
  });

  it('is account-scoped — A being offered does not suppress B (AE7)', () => {
    const storage = makeStorage();
    const memory = createOfferMemory();
    recordOffered(storage, memory, KEY_A);
    assert.equal(hasBeenOffered(storage, memory, KEY_B), false);
  });

  it('uses one key per account, so B never overwrites A', () => {
    const storage = makeStorage();
    const memory = createOfferMemory();
    recordOffered(storage, memory, KEY_A);
    recordOffered(storage, memory, KEY_B);
    // Re-read A through a fresh memory so only the persistent tier can answer.
    assert.equal(hasBeenOffered(storage, createOfferMemory(), KEY_A), true);
    assert.equal(hasBeenOffered(storage, createOfferMemory(), KEY_B), true);
    assert.equal(storage.data.size, 2);
  });

  it('ignores a record stored under a previous key version', () => {
    const storage = makeStorage();
    storage.data.set(`wm-passkey-offer-shown-v0:${KEY_A}`, JSON.stringify({ at: Date.now() }));
    assert.equal(hasBeenOffered(storage, createOfferMemory(), KEY_A), false);
  });

  it('treats a malformed payload as not-yet-offered rather than throwing', () => {
    const storage = makeStorage();
    storage.data.set(passkeyOfferStorageKey(KEY_A), '{"at":');
    assert.doesNotThrow(() => hasBeenOffered(storage, createOfferMemory(), KEY_A));
    assert.equal(hasBeenOffered(storage, createOfferMemory(), KEY_A), false);
  });

  it('does nothing for a null account key instead of writing a junk record', () => {
    const storage = makeStorage();
    const memory = createOfferMemory();
    recordOffered(storage, memory, null);
    assert.equal(storage.data.size, 0);
    assert.equal(hasBeenOffered(storage, memory, null), false);
  });
});

describe('the in-memory tier', () => {
  it('reads not-yet-offered when the storage handle throws on read (AE8)', () => {
    const storage = makeStorage({ throwOnGet: true });
    assert.equal(hasBeenOffered(storage, createOfferMemory(), KEY_A), false);
  });

  it('does not throw when the storage handle throws on write (AE8)', () => {
    const storage = makeStorage({ throwOnSet: true });
    assert.doesNotThrow(() => recordOffered(storage, createOfferMemory(), KEY_A));
  });

  it('carries suppression across two auth cycles when BOTH read and write throw (AE16)', () => {
    // The whole point of the second tier. Without it, a storage-disabled
    // browser re-offers on every sign-out/sign-in within the same page.
    const storage = makeStorage({ throwOnGet: true, throwOnSet: true });
    const memory = createOfferMemory();

    assert.equal(hasBeenOffered(storage, memory, KEY_A), false);
    recordOffered(storage, memory, KEY_A);

    // Second cycle, same page, same controller-lifetime memory.
    assert.equal(hasBeenOffered(storage, memory, KEY_A), true);
  });

  it('is written before the persistent attempt, so a throwing setItem still suppresses', () => {
    const storage = makeStorage({ throwOnSet: true });
    const memory = createOfferMemory();
    recordOffered(storage, memory, KEY_A);
    assert.equal(storage.data.size, 0, 'persistent write must have failed for this test to mean anything');
    assert.equal(hasBeenOffered(storage, memory, KEY_A), true);
  });

  it('is account-scoped too', () => {
    const storage = makeStorage({ throwOnGet: true, throwOnSet: true });
    const memory = createOfferMemory();
    recordOffered(storage, memory, KEY_A);
    assert.equal(hasBeenOffered(storage, memory, KEY_B), false);
  });
});

describe('a null storage handle (PR #7353 review)', () => {
  // A browser that throws on `localStorage` ACCESS gives the caller no handle
  // at all. Gating the ledger calls on a non-null handle silently discards the
  // in-memory tier, which is the entire fallback.
  it('still suppresses via the in-memory tier when there is no handle', () => {
    const memory = createOfferMemory();
    assert.equal(hasBeenOffered(null, memory, KEY_A), false);
    recordOffered(null, memory, KEY_A);
    assert.equal(hasBeenOffered(null, memory, KEY_A), true);
  });

  it('stays account-scoped with no handle', () => {
    const memory = createOfferMemory();
    recordOffered(null, memory, KEY_A);
    assert.equal(hasBeenOffered(null, memory, KEY_B), false);
  });

  it('does not throw on either call with no handle', () => {
    const memory = createOfferMemory();
    assert.doesNotThrow(() => recordOffered(null, memory, KEY_A));
    assert.doesNotThrow(() => hasBeenOffered(null, memory, KEY_A));
  });
});

describe('shouldOfferPasskey', () => {
  const OFFERABLE = {
    environmentEligible: true,
    sessionReady: true,
    existingPasskeyCount: 0,
    alreadyOffered: false,
  };

  it('offers when the environment is eligible, no passkey exists, and no record (AE1)', () => {
    assert.equal(shouldOfferPasskey(OFFERABLE), true);
  });

  it('does not offer when the account already has a passkey (AE4)', () => {
    assert.equal(shouldOfferPasskey({ ...OFFERABLE, existingPasskeyCount: 1 }), false);
  });

  it('does not offer when the environment is ineligible, whatever else is true', () => {
    assert.equal(shouldOfferPasskey({ ...OFFERABLE, environmentEligible: false }), false);
  });

  it('does not offer when the session is not ready (AE11)', () => {
    assert.equal(shouldOfferPasskey({ ...OFFERABLE, sessionReady: false }), false);
  });

  it('does not offer when a ledger record exists, even with zero passkeys (AE6)', () => {
    assert.equal(shouldOfferPasskey({ ...OFFERABLE, alreadyOffered: true }), false);
  });
});
