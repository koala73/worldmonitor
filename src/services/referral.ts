// Client referral service (Phase 9 / Todo #223).
//
// Thin wrapper around /api/referral/me + the Web Share API. Used by
// the LatestBriefPanel's share button and any future "share this
// brief" surface. Profile is cached in-memory for 5 min because the
// code is immutable (deterministic hash of Clerk userId) and the
// invited count updates slowly.

import { getClerkToken } from '@/services/clerk';

export interface ReferralProfile {
  code: string;
  shareUrl: string;
  invitedCount: number;
}

let _cached: { at: number; data: ReferralProfile } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch the signed-in user's referral profile. Returns null when the
 * user isn't signed in or the endpoint is misconfigured — UI falls
 * back to hiding the share button in that case.
 */
export async function getReferralProfile(): Promise<ReferralProfile | null> {
  if (_cached && Date.now() - _cached.at < CACHE_TTL_MS) return _cached.data;
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
    _cached = { at: Date.now(), data };
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
