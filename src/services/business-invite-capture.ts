/**
 * Holds a Business seat invite from the moment its link loads until a signed-in
 * account can accept it.
 *
 * The invite email links to /dashboard?accept-business-invite=<grantId>&token=<t>.
 * The dashboard's map URL sync rewrites the query string from map state shortly
 * after boot, so an invitee who arrives signed out and then creates an account
 * would reach the accept hook with both params gone. Capture runs at the start
 * of App.init(), before that sync and before the auth subscription.
 *
 * sessionStorage, not localStorage: the token is a single-use credential, so it
 * stays in the tab that opened the link. It still survives the full page load
 * Clerk performs when sign-up completes. A module copy covers the same page
 * load when storage is unavailable (Android WebView exposes it as null).
 */

export const BUSINESS_INVITE_STORAGE_KEY = 'wm-business-invite-pending';

const GRANT_PARAM = 'accept-business-invite';
const TOKEN_PARAM = 'token';

export interface PendingBusinessInvite {
  grantId: string;
  token: string;
}

let memoryInvite: PendingBusinessInvite | null = null;

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function isInvite(value: unknown): value is PendingBusinessInvite {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.grantId === 'string' && record.grantId.length > 0
    && typeof record.token === 'string' && record.token.length > 0;
}

function sameInvite(a: PendingBusinessInvite, b: PendingBusinessInvite): boolean {
  return a.grantId === b.grantId && a.token === b.token;
}

/**
 * Read the invite params from the current URL, store them, and remove them
 * from the visible URL. A link carrying only one of the two params is left
 * alone: `token` alone is too generic to claim.
 */
export function captureBusinessInviteFromUrl(): PendingBusinessInvite | null {
  if (typeof window === 'undefined') return null;
  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch {
    return null;
  }
  const grantId = url.searchParams.get(GRANT_PARAM);
  const token = url.searchParams.get(TOKEN_PARAM);
  if (!grantId || !token) return null;

  const invite: PendingBusinessInvite = { grantId, token };
  memoryInvite = invite;
  try {
    storage()?.setItem(BUSINESS_INVITE_STORAGE_KEY, JSON.stringify(invite));
  } catch {
    // Quota or privacy-mode denial: the module copy still serves this page load.
  }

  url.searchParams.delete(GRANT_PARAM);
  url.searchParams.delete(TOKEN_PARAM);
  try {
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    // History API unavailable; the values are already captured.
  }
  return invite;
}

/** The invite waiting for a signed-in account, or null. */
export function loadPendingBusinessInvite(): PendingBusinessInvite | null {
  if (memoryInvite) return memoryInvite;
  const store = storage();
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(BUSINESS_INVITE_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!isInvite(parsed)) {
    try { store.removeItem(BUSINESS_INVITE_STORAGE_KEY); } catch { /* best effort */ }
    return null;
  }
  memoryInvite = { grantId: parsed.grantId, token: parsed.token };
  return memoryInvite;
}

/**
 * Forget `invite` once an accept attempt has settled. A different invite
 * captured while that attempt was in flight stays pending.
 */
export function clearPendingBusinessInvite(invite: PendingBusinessInvite): void {
  const current = loadPendingBusinessInvite();
  if (!current || !sameInvite(current, invite)) return;
  memoryInvite = null;
  try {
    storage()?.removeItem(BUSINESS_INVITE_STORAGE_KEY);
  } catch {
    // best effort
  }
}

/** Rejection kinds acceptBusinessInvite throws (convex/payments/businessSeats.ts). */
const INVITE_ERROR_KINDS = [
  'INVITE_EMAIL_MISMATCH',
  'INVITE_EXPIRED',
  'BUSINESS_NOT_ACTIVE',
  'INVITE_ALREADY_USED',
  'INVALID_INVITE_TOKEN',
  'GRANT_NOT_FOUND',
  'INVITEE_EMAIL_UNAVAILABLE',
  'INVITEE_DOMAIN_NOT_CORPORATE',
] as const;

/**
 * The `kind` of an acceptBusinessInvite rejection. Object-data ConvexErrors
 * carry it on `err.data.kind`; the message is not guaranteed to contain it in
 * production, so it is only a fallback for a known kind.
 */
export function businessInviteErrorKind(err: unknown): string | null {
  const data = (err as { data?: unknown } | null | undefined)?.data;
  if (data && typeof data === 'object' && 'kind' in data) {
    const kind = (data as Record<string, unknown>).kind;
    if (typeof kind === 'string') return kind;
  }
  const msg = err instanceof Error ? err.message : '';
  return INVITE_ERROR_KINDS.find((kind) => msg.includes(kind)) ?? null;
}

export interface BusinessInviteAttempt {
  /** The server accepted the invite, whatever happened to the account afterwards. */
  accepted: boolean;
  /** Clerk no longer has the account that sent the request. */
  accountChanged: boolean;
  /** The rejection kind when the request failed, from businessInviteErrorKind. */
  errorKind?: string | null;
}

/**
 * Whether the invite should stay pending after an accept attempt settles.
 * An accepted invite is done. A rejection the account caused, either a
 * different signed-in address or an account switch before the answer came
 * back, leaves it for the invited account to accept in this tab. Any other
 * rejection is final for this invite.
 */
export function keepInviteAfterAttempt(attempt: BusinessInviteAttempt): boolean {
  if (attempt.accepted) return false;
  if (attempt.accountChanged) return true;
  return attempt.errorKind === 'INVITE_EMAIL_MISMATCH';
}

export function resetBusinessInviteMemoryForTests(): void {
  memoryInvite = null;
}
