/**
 * Cross-session referral-code capture for dashboard-origin checkouts.
 *
 * Flow: a visitor lands on `/pro?ref=<code>`, clicks through to the
 * dashboard (either directly or after a free-tier trial), eventually
 * upgrades from within the dashboard. Without this module, the ref
 * code is lost at the `/pro` → dashboard navigation and the Dodo
 * checkout never carries it in `affonso_referral`.
 *
 * Persistence model: localStorage (NOT sessionStorage) so the code
 * survives tab close / new-tab navigations. Paired with a 7-day TTL
 * and explicit clear on attributed purchase so we don't credit a
 * sharer indefinitely or on multiple purchases from the same funnel.
 *
 * Separate from `checkout-attempt.ts` because lifetime + storage tier
 * differ: attempts are sessionStorage-scoped (dies on tab close) while
 * referrals must persist across sessions. Pure module (no SDK deps)
 * so unit tests can exercise every branch without a browser env.
 */

export const REFERRAL_CAPTURE_KEY = 'wm-referral-capture';
export const REFERRAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * URL query params we accept as the inbound referral signal. The `/pro`
 * marketing page has always used `?ref=`; the dashboard adopts
 * `?wm_referral=` going forward because `ref` is too generic and risks
 * collision with unrelated redirect targets (some payment providers
 * use `ref` as their own routing key).
 */
const REFERRAL_PARAM_NAMES = ['wm_referral', 'ref'] as const;

export interface ReferralCapture {
  code: string;
  capturedAt: number;
}

interface BrowserLike {
  location: { href: string; pathname: string; search: string; hash: string };
  history: { replaceState: (state: unknown, unused: string, url?: string | URL | null) => void };
}

function getBrowser(): BrowserLike | null {
  if (typeof window === 'undefined') return null;
  return window as unknown as BrowserLike;
}

/**
 * Inspect the current URL for a referral param and, if found, persist
 * it to localStorage and strip it from the URL.
 *
 * Call once during app bootstrap. Cleans the URL via `replaceState`
 * whether or not we persisted, so a stale param that failed validation
 * doesn't linger visible to the user.
 *
 * Returns the captured code (or null when no param was present /
 * storage is disabled / input was invalid).
 */
export function captureReferralFromUrl(): string | null {
  const browser = getBrowser();
  if (!browser) return null;

  let url: URL;
  try {
    url = new URL(browser.location.href);
  } catch {
    return null;
  }

  let captured: string | null = null;
  let mutated = false;
  for (const param of REFERRAL_PARAM_NAMES) {
    const value = url.searchParams.get(param);
    if (value !== null) {
      url.searchParams.delete(param);
      mutated = true;
      if (captured === null && isValidCode(value)) {
        captured = value;
      }
    }
  }

  if (mutated) {
    const clean = url.pathname + (url.searchParams.toString() ? `?${url.searchParams.toString()}` : '') + url.hash;
    try {
      browser.history.replaceState({}, '', clean);
    } catch {
      // History API unavailable (extreme embed/iframe cases) — the URL
      // stays as-is but we've already read the value we needed.
    }
  }

  if (captured) {
    const record: ReferralCapture = { code: captured, capturedAt: Date.now() };
    try {
      localStorage.setItem(REFERRAL_CAPTURE_KEY, JSON.stringify(record));
    } catch {
      // localStorage disabled (private browsing / partitioned storage
      // denial) — graceful degrade: subsequent loadActiveReferral()
      // calls return null and the dashboard-origin upgrade path falls
      // back to no referral attribution, same as if the user never
      // arrived via a shared link. Safari ITP and similar partitioned
      // modes still allow origin-scoped localStorage in first-party
      // contexts, which is where this module runs.
    }
  }
  return captured;
}

/**
 * Read the active referral code if one is stored and non-stale.
 * Stale records (>7 days old) are cleared eagerly on read so the
 * next caller sees a clean state — this is the backstop for the
 * edge case where a successful paid attribution never fires the
 * clear hook (cross-device purchase, webhook landed on another
 * session, etc).
 */
export function loadActiveReferral(): string | null {
  try {
    const raw = localStorage.getItem(REFERRAL_CAPTURE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ReferralCapture;
    if (!parsed || typeof parsed.code !== 'string' || typeof parsed.capturedAt !== 'number') {
      localStorage.removeItem(REFERRAL_CAPTURE_KEY);
      return null;
    }
    if (!isValidCode(parsed.code)) {
      localStorage.removeItem(REFERRAL_CAPTURE_KEY);
      return null;
    }
    if (Date.now() - parsed.capturedAt > REFERRAL_TTL_MS) {
      localStorage.removeItem(REFERRAL_CAPTURE_KEY);
      return null;
    }
    return parsed.code;
  } catch {
    // Malformed JSON / storage failure → treat as absent.
    try { localStorage.removeItem(REFERRAL_CAPTURE_KEY); } catch { /* noop */ }
    return null;
  }
}

/**
 * Clear the stored referral. Called from the terminal-success path
 * of `clearCheckoutAttempt('success')` so a single successful paid
 * attribution retires the code — preventing the same share link
 * from getting credit on subsequent purchases from the same user.
 */
export function clearReferralOnAttribution(): void {
  try {
    localStorage.removeItem(REFERRAL_CAPTURE_KEY);
  } catch {
    // Storage failures are silent — see captureReferralFromUrl rationale.
  }
}

/**
 * Append a referral query param to a URL, preserving any existing
 * params. Used by `/pro` hero/CTA links that send visitors to the
 * dashboard so the ref code survives the navigation and gets
 * captured by captureReferralFromUrl() on arrival.
 *
 * Returns the original URL unchanged when refCode is falsy so callers
 * can pass `appendRefToUrl(url, maybeRef)` without guarding.
 */
export function appendRefToUrl(url: string, refCode: string | undefined | null): string {
  if (!refCode) return url;
  if (!isValidCode(refCode)) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('wm_referral', refCode);
    return parsed.toString();
  } catch {
    // Relative or otherwise unparseable URL — fall back to a string
    // append so in-product anchors still carry the code through.
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}wm_referral=${encodeURIComponent(refCode)}`;
  }
}

/**
 * Loose validator for referral codes. Affonso codes are alphanumeric
 * short tokens; we reject anything with whitespace, control chars, or
 * suspicious payload-like patterns so a hostile URL can't inject a
 * code containing script/URL content that later renders somewhere.
 */
function isValidCode(code: string): boolean {
  if (typeof code !== 'string') return false;
  if (code.length === 0 || code.length > 64) return false;
  // Allow alphanumeric + `-` `_` only; no whitespace, no slashes, no
  // URL-reserved chars. Keeps any future rendering path (e.g., Sentry
  // extra) safe without needing per-caller escaping.
  return /^[a-zA-Z0-9_-]+$/.test(code);
}
