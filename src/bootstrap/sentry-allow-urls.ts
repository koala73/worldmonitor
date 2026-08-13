/**
 * Sentry `allowUrls` — the ingest gate for browser events.
 *
 * Sentry drops an event outright when no frame URL matches one of these
 * patterns, BEFORE `beforeSend` runs. A served host missing from the
 * alternation is therefore a total, silent observability blackout for that
 * host, not a filtering nuance: `energy.` was absent while
 * `energy.worldmonitor.app` was live, so every error-level browser event from
 * the energy variant was discarded (#6545).
 *
 * The alternation must cover every host the app is served on — the apex,
 * `www.`, and one entry per non-`full` `SITE_VARIANTS` subdomain
 * (`src/config/variant.ts`). `tests/sentry-allow-urls.test.mts` derives that
 * population from `SITE_VARIANTS` and `DEBUGBEAR_RUM_HOSTS` rather than
 * restating it, so the next variant subdomain cannot repeat the drift.
 *
 * Keep in sync with `pro-test/src/sentry-allow-urls.ts` (asserted by the same
 * test). Both bundles run on every variant host: `vercel.json` rewrites `/` on
 * each variant host to the marketing `/pro/welcome.html`, and `/dashboard` to
 * that variant's dashboard entry.
 */
export const SENTRY_ALLOW_URLS: RegExp[] = [
  /https?:\/\/(www\.|tech\.|finance\.|commodity\.|happy\.|energy\.)?worldmonitor\.app/,
  /https?:\/\/.*\.vercel\.app/,
];
