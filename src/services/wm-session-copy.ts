/**
 * User-facing copy for a degraded anonymous session.
 *
 * Deliberately a dependency-free leaf: `wm-session.ts` reaches the runtime
 * fetch patch through `@/` path aliases, which makes it unimportable from the
 * `tsx --test` suites. Keeping the decision here — the same reason
 * `premium-intent.ts` exists — lets the copy be pinned without a DOM, which
 * matters because the bug this fixes was purely a wrong-remedy string that no
 * type or wiring check could have caught.
 */

export type WmSessionDeadReason = 'mint_failed' | 'retry_401' | 'cookie_not_persisted';

/** Fallback for a degraded event dispatched by a pre-#6120 bundle (no detail). */
export const WM_SESSION_DEGRADED_FALLBACK_COPY =
  'Anonymous data is temporarily unavailable. Check your cookie settings, then reload.';

/**
 * The remedy to show for a degraded anonymous session, chosen by what actually
 * failed. The three reasons have three different fixes and only one of them is
 * about cookies — the single blanket message told the majority of affected
 * users to check a setting that was never the cause (WORLDMONITOR-WG residual,
 * where `mint_failed` is ~2/3 of episodes):
 *
 *  - `mint_failed` — `/api/wm-session` never answered (offline, a content
 *    blocker, or the 10s timeout). Cookie settings are irrelevant.
 *  - `cookie_not_persisted` — the browser took a cookie and dropped it. The
 *    only case where cookie settings are the fix.
 *  - `retry_401` — the cookie was delivered and the server rejected it, so the
 *    session is stale rather than missing; a reload mints a fresh one.
 */
export function describeWmSessionDegradation(reason: WmSessionDeadReason): string {
  switch (reason) {
    case 'cookie_not_persisted':
      return WM_SESSION_DEGRADED_FALLBACK_COPY;
    case 'mint_failed':
      return 'Anonymous data is temporarily unavailable. Check your connection or content blocker, then reload.';
    case 'retry_401':
      return 'Anonymous data is temporarily unavailable. Reload to start a new session.';
  }
}
