import { ACCOUNT_OFFER_CAP } from '../../shared/passkey-offer-contract';

export interface PasskeyOfferSlotStore {
  /** Returns true only when this call claimed an unused slot. */
  claim(slot: number): Promise<boolean>;
}

export type PasskeyOfferReservation =
  | { status: 'reserved'; count: number }
  | { status: 'cap-reached'; count: typeof ACCOUNT_OFFER_CAP };

function boundedMigrationCount(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(Math.floor(count), ACCOUNT_OFFER_CAP);
}

/**
 * Reserve one of the account's three lifetime offer slots.
 *
 * Each slot is an independent first-writer-wins fact. The store must implement
 * `claim` with an atomic primitive such as Redis HSETNX. Concurrent devices can
 * then contend without reading or replacing one shared counter.
 */
export async function reservePasskeyOfferSlot(
  store: PasskeyOfferSlotStore,
  migratedCount: number,
): Promise<PasskeyOfferReservation> {
  const seededCount = boundedMigrationCount(migratedCount);
  for (let slot = 1; slot <= seededCount; slot += 1) {
    await store.claim(slot);
  }

  for (let slot = seededCount + 1; slot <= ACCOUNT_OFFER_CAP; slot += 1) {
    if (await store.claim(slot)) return { status: 'reserved', count: slot };
  }

  return { status: 'cap-reached', count: ACCOUNT_OFFER_CAP };
}
