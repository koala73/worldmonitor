/** Browser-readable mirror of the authoritative server reservation count. */
export const ACCOUNT_OFFER_COUNT_KEY = 'wmPasskeyOfferCount';

/** Read-only migration marker from the original single-offer policy. */
export const LEGACY_ACCOUNT_OFFER_KEY = 'wmPasskeyOfferedAt';

/** Maximum number of account-wide offer reservations. */
export const ACCOUNT_OFFER_CAP = 3;

export interface PasskeyOfferMetadataReader {
  unsafeMetadata?: Record<string, unknown> | null;
}

export function readAccountOfferCount(
  user: PasskeyOfferMetadataReader | null | undefined,
): number {
  const raw = user?.unsafeMetadata?.[ACCOUNT_OFFER_COUNT_KEY];
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  const legacy = user?.unsafeMetadata?.[LEGACY_ACCOUNT_OFFER_KEY];
  return typeof legacy === 'number' && Number.isFinite(legacy) && legacy > 0 ? 1 : 0;
}
