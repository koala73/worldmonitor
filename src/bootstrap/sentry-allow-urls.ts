/**
 * Marketing copy of the Sentry ingest allowlist. `pro-test` builds from its own root
 * and cannot import `src/`, so this mirrors `src/bootstrap/sentry-allow-urls.ts` the
 * same way `pro-test/src/debugbear-rum.ts` mirrors its dashboard sibling.
 * `tests/sentry-allow-urls.test.mts` asserts the two lists stay identical and
 * exercises both against the served-host population.
 *
 * Kept dependency-free (no `@sentry/react` import) so the guard can import the real
 * value instead of re-deriving it from source text.
 *
 * Read the dashboard copy for why a missing host is a total blackout rather than a
 * filtering nuance, why the population is "hosts that serve the app" rather than the
 * variant list, and why both patterns are anchored (#6545, WORLDMONITOR-K7 / -Q4).
 */
export const SENTRY_ALLOW_URLS: RegExp[] = [
  /^https?:\/\/(www\.|app\.|api\.|tech\.|finance\.|commodity\.|happy\.|energy\.)?worldmonitor\.app(?=[:/?#]|$)/,
  /^https?:\/\/[^/]*\.vercel\.app(?=[:/?#]|$)/,
];
