/**
 * Which origins may receive a post-payment `returnUrl` redirect.
 *
 * Vercel serves the deployment on EVERY attached domain, so any host pointed at the
 * project renders the full app — `https://api.worldmonitor.app/dashboard` returns the
 * real dashboard, not a 404. The allowlist therefore has to track "hosts that serve
 * the app", and it silently drifted: `api.worldmonitor.app` was missing, so 12 distinct
 * signed-in users who opened the dashboard on the API host got a 500 from
 * /api/create-checkout instead of a checkout page (WORLDMONITOR-K7 / -Q4).
 *
 * Deliberately NOT a `*.worldmonitor.app` suffix match. The guard's job is blocking
 * open redirects, and several worldmonitor.app subdomains are vendor-owned CNAMEs
 * (`clerk.` → Clerk, `abacus.` → Umami). A suffix rule would quietly promote every
 * current and future vendor subdomain to a valid post-payment redirect target, so the
 * list stays enumerated and `tests/checkout-return-url-origin.test.mts` pins both
 * directions.
 */

/** App-serving origins trusted as post-payment return targets. */
export const TRUSTED_RETURN_URL_ORIGINS: readonly string[] = [
  "https://worldmonitor.app",
  "https://www.worldmonitor.app",
  "https://app.worldmonitor.app",
  "https://api.worldmonitor.app",
  "https://tech.worldmonitor.app",
  "https://finance.worldmonitor.app",
  "https://commodity.worldmonitor.app",
  "https://happy.worldmonitor.app",
  "https://energy.worldmonitor.app",
];

/**
 * True when `origin` is an exact-match trusted origin. `extraOrigin` carries the
 * deployment's own `SITE_URL` origin so preview/self-hosted deploys keep working.
 *
 * Compares full origin strings (scheme + host + port), so `http://worldmonitor.app`,
 * `https://worldmonitor.app:8443` and `https://worldmonitor.app.evil.com` all fail.
 */
export function isTrustedReturnUrlOrigin(origin: string, extraOrigin?: string): boolean {
  if (!origin) return false;
  if (TRUSTED_RETURN_URL_ORIGINS.includes(origin)) return true;
  return Boolean(extraOrigin) && origin === extraOrigin;
}
