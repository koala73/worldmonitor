/**
 * @file One-shot loader that caches success and rate-limits failure.
 *
 * The bundled data packs (Natural Earth regions, neighborhood polygons) are
 * loaded once per session and memoized. Memoizing the *promise* is the cheap
 * way to do that, but it silently turns one transient failure into a
 * session-long outage: every later call re-returns the same rejection, and
 * the callers — which `.catch(() => null)` — report it to the user as "no
 * such region" rather than "the data pack didn't load".
 *
 * This keeps the memoization and drops it on rejection, so a later caller
 * retries. Retries are NOT immediate: a voice/analyst caller in a loop would
 * otherwise hammer a permanently broken pack once per spoken query. A failed
 * loader serves its recorded rejection until a cooldown elapses, doubling per
 * consecutive failure up to a ceiling. Concurrent callers share one in-flight
 * load; success is cached permanently.
 *
 * @module data/retryableLoad
 */

/** @const {number} Ms before a first retry is allowed. */
export const RETRY_COOLDOWN_MS = 5_000;
/** @const {number} Ms ceiling for the doubling backoff. */
export const RETRY_COOLDOWN_MAX_MS = 300_000;

/**
 * Wrap a loader so its result is memoized but its failures are rate-limited.
 *
 * @template T
 * @param {() => (Promise<T>|T)} load - Runs at most once per successful load.
 * @param {Object} [options]
 * @param {number} [options.cooldownMs] - Backoff after the first failure.
 * @param {number} [options.maxCooldownMs] - Ceiling for the doubling backoff.
 * @param {() => number} [options.now] - Clock seam for tests.
 * @returns {() => Promise<T>} Memoized loader; retries once the cooldown elapses.
 */
export function createRetryableLoader(load, {
  cooldownMs = RETRY_COOLDOWN_MS,
  maxCooldownMs = RETRY_COOLDOWN_MAX_MS,
  now = () => Date.now(),
} = {}) {
  /** @type {Promise<T>|null} */
  let inflight = null;
  /** @type {*} Last rejection, replayed to callers inside the cooldown. */
  let failure = null;
  /** Explicit flag: a loader may reject with a falsy value (null, 0, ''). */
  let hasFailure = false;
  let failedAt = 0;
  let consecutiveFailures = 0;

  return function loadOnce() {
    if (inflight) return inflight;
    if (hasFailure) {
      const wait = Math.min(cooldownMs * 2 ** (consecutiveFailures - 1), maxCooldownMs);
      // Replay the recorded reason rather than re-running a loader that is
      // probably still broken. Callers see identical behavior either way.
      if (now() - failedAt < wait) return Promise.reject(failure);
    }
    // Normalizes a synchronous throw into a rejection, so a broken loader
    // cannot escape the retry contract.
    const attempt = (async () => load())();
    inflight = attempt;
    attempt.then(
      () => {
        // Success is permanent: `inflight` stays set and holds the value.
        if (inflight === attempt) {
          failure = null;
          hasFailure = false;
          consecutiveFailures = 0;
        }
      },
      (error) => {
        // Only clear our own attempt: a retry may already have replaced it.
        if (inflight === attempt) {
          inflight = null;
          failure = error;
          hasFailure = true;
          failedAt = now();
          consecutiveFailures += 1;
        }
      },
    );
    return attempt;
  };
}
