// Client referral service (Phase 9 / Todo #223).
//
// Thin wrapper around /api/referral/me + the Web Share API.
//
// Cache shape: keyed by Clerk userId. Without a user-id key, a stale
// cache primed by user A can hand user B user A's share link for up
// to 5 minutes after an account switch — even if no panel is
// mounted to call clearReferralCache() at transition time. The
// auth-state subscription below also self-invalidates on any id
// transition as defence in depth.

import { getClerkToken } from '@/services/clerk';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';

export interface ReferralProfile {
  code: string;
  shareUrl: string;
}

interface CacheEntry {
  at: number;
  userId: string;
  data: ReferralProfile;
}

let _cached: CacheEntry | null = null;
let _lastSeenUserId: string | null = null;
let _authSubscribed = false;
const CACHE_TTL_MS = 5 * 60 * 1000;

function ensureAuthSubscription(): void {
  if (_authSubscribed) return;
  _authSubscribed = true;
  _lastSeenUserId = getAuthState().user?.id ?? null;
  subscribeAuthState((state) => {
    const nextId = state.user?.id ?? null;
    if (nextId !== _lastSeenUserId) {
      _lastSeenUserId = nextId;
      _cached = null;
    }
  });
}

/**
 * Fetch the signed-in user's referral profile. Returns null when the
 * user isn't signed in or the endpoint is misconfigured — UI falls
 * back to hiding the share button in that case.
 */
export async function getReferralProfile(): Promise<ReferralProfile | null> {
  ensureAuthSubscription();
  const currentUserId = getAuthState().user?.id ?? null;
  if (!currentUserId) {
    _cached = null;
    return null;
  }
  // Cache hit ONLY when the cached userId matches the current user.
  // A mismatch means an account switch happened between prime and
  // read; drop and re-fetch.
  if (
    _cached &&
    _cached.userId === currentUserId &&
    Date.now() - _cached.at < CACHE_TTL_MS
  ) {
    return _cached.data;
  }
  let token: string | null = null;
  try {
    token = await getClerkToken();
  } catch {
    return null;
  }
  if (!token) return null;
  try {
    const res = await fetch('/api/referral/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as ReferralProfile;
    if (!data?.code || !data?.shareUrl) return null;
    // Re-check the current user before caching — the user may have
    // switched accounts while the fetch was in flight, in which case
    // this profile belongs to the previous user and caching it would
    // poison the next reader.
    const userNow = getAuthState().user?.id ?? null;
    if (userNow !== currentUserId) return null;
    _cached = { at: Date.now(), userId: currentUserId, data };
    return data;
  } catch {
    return null;
  }
}

/**
 * Share or copy the referral link. Prefers Web Share API (native
 * sheet on iOS/Android, Chrome mobile, Safari); falls back to
 * clipboard with a caller-provided feedback hook.
 *
 * Returns:
 *   - 'shared'  : Web Share sheet opened and completed
 *   - 'copied'  : clipboard fallback wrote the link
 *   - 'blocked' : user dismissed the share sheet
 *   - 'error'   : neither Web Share nor clipboard worked
 */
export type ShareResult = 'shared' | 'copied' | 'blocked' | 'error';

export async function shareReferral(profile: ReferralProfile): Promise<ShareResult> {
  const url = profile.shareUrl;
  const text = 'Get geopolitical intelligence in a daily editorial brief. Join me on WorldMonitor:';
  // Web Share — mobile primary path.
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: 'WorldMonitor', text, url });
      return 'shared';
    } catch (err) {
      // User dismissed the sheet or the browser denied — fall through
      // to clipboard. AbortError is the documented "user cancelled"
      // path and we don't want to swallow it as an error toast.
      if ((err as { name?: string } | null)?.name === 'AbortError') return 'blocked';
      // Fallthrough to clipboard.
    }
  }
  // Clipboard — desktop primary path.
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(url);
      return 'copied';
    } catch {
      return 'error';
    }
  }
  return 'error';
}

/** Invalidate the cached profile — call after sign-out / account switch. */
export function clearReferralCache(): void {
  _cached = null;
}
