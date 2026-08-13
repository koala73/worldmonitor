/**
 * Marketing copy of the Sentry ingest allowlist. `pro-test` builds from its own
 * root and cannot import `src/`, so this mirrors
 * `src/bootstrap/sentry-allow-urls.ts` the same way `pro-test/src/debugbear-rum.ts`
 * mirrors its dashboard sibling. `tests/sentry-allow-urls.test.mts` asserts the
 * two lists stay identical.
 *
 * Kept dependency-free (no `@sentry/react` import) so the guard can import the
 * real value instead of re-deriving it from source text.
 *
 * Read the dashboard copy for why a missing host is a blackout rather than a
 * filtering nuance (#6545).
 */
export const SENTRY_ALLOW_URLS: RegExp[] = [
  /https?:\/\/(www\.|tech\.|finance\.|commodity\.|happy\.|energy\.)?worldmonitor\.app/,
  /https?:\/\/.*\.vercel\.app/,
];
