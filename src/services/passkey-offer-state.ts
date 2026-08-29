/**
 * The passkey offer ledger: who has already been offered, and whether to offer
 * now.
 *
 * The contract is "at most once per account per origin, best effort". Three
 * things make that phrasing honest rather than weaselly, and each is a real
 * limit rather than a bug to fix later:
 *
 *   - The record is written when the prompt MOUNTS, not when the user answers.
 *     Anything else re-offers to whoever closed the tab with it open.
 *   - `localStorage` is origin-scoped, so a dismissal on `www` does not carry to
 *     a variant subdomain. The passkey's relying party is the registrable
 *     domain while storage is not, and no local mechanism reconciles that.
 *   - Two tabs can both read an empty ledger and mount. A read-then-write is
 *     not an atomic claim.
 *
 * Those limits are why a THIRD tier exists below. `hasAccountOfferRecord` and
 * `recordAccountOffer` keep the flag on the Clerk user itself, which is
 * account-scoped and server-backed and therefore immune to all three.
 * Production forced this. The offer only ever fired on a sign-in transition, so
 * the whole already-signed-in population was never asked, and relaxing that
 * guard is only safe once "already offered" survives a browser with storage
 * disabled.
 *
 * The local tiers are not redundant with it. They answer synchronously, before
 * any network read, which is what lets the eager boot shim skip its dynamic
 * import outright on the common repeat visit.
 *
 * Every decision here is pure and every storage handle is injected, so the
 * tests need no jsdom and no globals.
 */

// ---------------------------------------------------------------------------
// Account scoping
// ---------------------------------------------------------------------------

/**
 * Stable, opaque, local account scope for offer records.
 *
 * Clerk user ids must not be persisted in origin-readable storage. FNV-1a 64
 * keeps this leaf synchronous and import-free while producing an opaque key
 * from Clerk's high-entropy id. Mirrors `deriveActivationAccountKey` in
 * `pro-activation-state.ts` — it is an account partition key, never
 * authentication, and it is obfuscation rather than anonymity: a stable
 * pseudonymous identifier for that account on that origin.
 */
export function derivePasskeyAccountKey(userId: string | null | undefined): string | null {
  if (!userId) return null;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < userId.length; i += 1) {
    hash ^= BigInt(userId.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `acct:${hash.toString(36)}`;
}

/**
 * Versioned storage key, one per account.
 *
 * Bump the `v1` suffix (never mutate it in place) to invalidate every stored
 * record — which is also the cheap lever for re-offering everyone if the launch
 * posture turns out wrong. One key per account rather than a shared collection:
 * a shared key would need read-modify-write on every mount and would lose
 * account isolation on a partial write.
 */
export function passkeyOfferStorageKey(accountKey: string): string {
  return `wm-passkey-offer-shown-v1:${accountKey}`;
}

// ---------------------------------------------------------------------------
// Storage tiers
// ---------------------------------------------------------------------------

/**
 * The slice of `localStorage` this module uses. Injected so tests stay
 * jsdom-free, and **nullable**: a browser that throws on `localStorage` access
 * has no handle at all, and the caller must still get the in-memory tier. Both
 * functions below take `OfferStorage | null` for exactly that reason — gating
 * the CALL on a non-null handle silently discards the fallback.
 */
export interface OfferStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * The within-page tier: account keys offered during this controller's lifetime.
 *
 * Failing safe on storage errors is right for a cold load but, on its own,
 * means nothing is remembered at all — sign out, sign back in, and the same
 * page re-offers. On a browser with storage disabled that is a nag on every
 * auth cycle. Create this once per controller and pass it through; a set
 * created per callback is indistinguishable from having none.
 */
export type OfferMemory = Set<string>;

/** Create the controller-lifetime memory tier. */
export function createOfferMemory(): OfferMemory {
  return new Set<string>();
}

/**
 * Whether this account has already been offered, consulting the persistent tier
 * first and the in-memory tier second.
 *
 * Never throws: a storage handle that rejects reads degrades to "not yet
 * offered" from the persistent tier, and the in-memory tier still answers.
 */
export function hasBeenOffered(
  storage: OfferStorage | null,
  memory: OfferMemory,
  accountKey: string | null,
): boolean {
  if (accountKey === null) return false;
  try {
    const raw = storage?.getItem(passkeyOfferStorageKey(accountKey)) ?? null;
    if (raw !== null && parseOfferRecord(raw) !== null) return true;
  } catch {
    // Storage unavailable — the in-memory tier below is the whole fallback.
  }
  return memory.has(accountKey);
}

/**
 * Record that this account has been offered.
 *
 * The in-memory write happens **before** the persistent attempt, which is what
 * makes suppression survive a throwing `setItem`. Reversing these two lines is
 * a silent regression: everything still passes except the storage-disabled
 * browser, which starts nagging again.
 */
export function recordOffered(
  storage: OfferStorage | null,
  memory: OfferMemory,
  accountKey: string | null,
): void {
  if (accountKey === null) return;
  memory.add(accountKey);
  try {
    storage?.setItem(passkeyOfferStorageKey(accountKey), JSON.stringify({ at: Date.now() }));
  } catch {
    // Persisting is best-effort; the in-memory tier already holds this page.
  }
}

/** Parse a stored record, tolerating anything that is not one. */
function parseOfferRecord(raw: string): { at: number } | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const at = (parsed as { at?: unknown }).at;
    return typeof at === 'number' && Number.isFinite(at) ? { at } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The durable tier: account-scoped state on the Clerk user
// ---------------------------------------------------------------------------

/**
 * Where the durable record lives inside `user.unsafeMetadata`.
 *
 * `unsafeMetadata` is user-writable by design, which is right for a cosmetic
 * "we already asked" flag and wrong for anything security bearing. Forging it
 * can only suppress an offer for the forger.
 */
export const ACCOUNT_OFFER_METADATA_KEY = 'wmPasskeyOfferedAt';

/** The read side of the Clerk user this module touches. */
export interface AccountOfferReader {
  unsafeMetadata?: Record<string, unknown> | null;
}

/** The write side. Clerk's `User.update` resolves once the patch is persisted. */
export interface AccountOfferWriter extends AccountOfferReader {
  update?: (params: { unsafeMetadata: Record<string, unknown> }) => Promise<unknown>;
}

/** Whether this account has been offered on ANY device or origin. */
export function hasAccountOfferRecord(user: AccountOfferReader | null | undefined): boolean {
  const at = user?.unsafeMetadata?.[ACCOUNT_OFFER_METADATA_KEY];
  return typeof at === 'number' && Number.isFinite(at) && at > 0;
}

/**
 * Persist the durable record. Resolves to whether it actually landed.
 *
 * The spread is load bearing. Clerk REPLACES `unsafeMetadata` wholesale rather
 * than merging, so writing a bare `{ [KEY]: ... }` would silently delete every
 * other key the app or a future feature keeps there.
 *
 * Never throws and never rejects. This runs at mount, and a failed metadata
 * write must not break a prompt already on screen. The local tiers still
 * suppress the repeat on this browser, which is the pre-existing behaviour
 * rather than a regression.
 */
export async function recordAccountOffer(user: AccountOfferWriter | null | undefined): Promise<boolean> {
  if (!user || typeof user.update !== 'function') return false;
  if (hasAccountOfferRecord(user)) return true;
  try {
    await user.update({
      unsafeMetadata: { ...(user.unsafeMetadata ?? {}), [ACCOUNT_OFFER_METADATA_KEY]: Date.now() },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * `localStorage` when reachable, null in private modes that throw on ACCESS.
 *
 * Shared by the eager boot shim and the controller so both consult the same
 * handle. Two independent helpers would be free to diverge on which failure
 * modes degrade to null.
 */
export function safeLocalStorage(): OfferStorage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The mount decision
// ---------------------------------------------------------------------------

/** Everything the mount decision needs, all resolved by the caller. */
export interface PasskeyOfferDecisionInput {
  environmentEligible: boolean;
  sessionReady: boolean;
  existingPasskeyCount: number;
  alreadyOffered: boolean;
}

/**
 * Whether to mount the offer.
 *
 * Pure and total: every gate is an injected boolean or count, so this is the
 * single function the acceptance examples assert against. The caller owns the
 * ordering that makes it cheap — the synchronous gates run before the async
 * platform-authenticator probe, so the common ineligible paths never touch it.
 */
export function shouldOfferPasskey(input: PasskeyOfferDecisionInput): boolean {
  if (!input.environmentEligible) return false;
  if (!input.sessionReady) return false;
  if (input.existingPasskeyCount > 0) return false;
  if (input.alreadyOffered) return false;
  return true;
}
