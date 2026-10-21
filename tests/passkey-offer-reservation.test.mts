import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  reservePasskeyOfferSlot,
  type PasskeyOfferSlotStore,
} from '../server/_shared/passkey-offer-reservation.ts';
import { ACCOUNT_OFFER_CAP } from '../shared/passkey-offer-contract.ts';

function slotStore(initial: number[] = []): PasskeyOfferSlotStore & {
  calls: number[];
  claimed: Set<number>;
} {
  const claimed = new Set(initial);
  const calls: number[] = [];
  return {
    calls,
    claimed,
    async claim(slot) {
      calls.push(slot);
      if (claimed.has(slot)) return false;
      claimed.add(slot);
      return true;
    },
  };
}

describe('passkey offer account reservation', () => {
  it('does not reopen a spent cap when the Clerk snapshot is stale', async () => {
    const store = slotStore([1, 2, 3]);

    const result = await reservePasskeyOfferSlot(store, 1);

    assert.deepEqual(result, { status: 'cap-reached', count: ACCOUNT_OFFER_CAP });
    assert.deepEqual([...store.claimed], [1, 2, 3]);
  });

  it('seeds legacy state before it claims the next slot', async () => {
    const store = slotStore();

    const result = await reservePasskeyOfferSlot(store, 2);

    assert.deepEqual(result, { status: 'reserved', count: 3 });
    assert.deepEqual(store.calls, [1, 2, 3]);
    assert.deepEqual([...store.claimed], [1, 2, 3]);
  });

  it('gives concurrent devices different slots', async () => {
    const store = slotStore();

    const results = await Promise.all([
      reservePasskeyOfferSlot(store, 0),
      reservePasskeyOfferSlot(store, 0),
      reservePasskeyOfferSlot(store, 0),
      reservePasskeyOfferSlot(store, 0),
    ]);

    assert.equal(results.filter((result) => result.status === 'reserved').length, ACCOUNT_OFFER_CAP);
    assert.equal(results.filter((result) => result.status === 'cap-reached').length, 1);
    assert.deepEqual([...store.claimed].sort(), [1, 2, 3]);
  });
});
