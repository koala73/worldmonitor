// Shared queue / outcome constants + opaque fingerprint helper for the
// simulation pipeline. Single source of truth imported by:
//   - scripts/seed-forecasts.mjs (the auto-trigger seeder + worker)
//   - server/_shared/simulation-queue.ts (the HTTP-trigger handler module)
//   - server/worldmonitor/forecast/v1/{trigger,get}-simulation*.ts (handlers)
//
// IMPORTANT — DO NOT MOVE THIS FILE BACK TO server/_shared/. The Railway
// services `seed-forecasts`, `simulation-worker`, and `deep-forecast-worker`
// use the nixpacks build with `root_dir=scripts`, which packages only
// `scripts/` contents into `/app/` in the container. A relative import that
// escapes `scripts/` (e.g. `../server/_shared/...`) resolves to
// `/server/_shared/...` at runtime — a path that does not exist in the
// container — and crashes every worker on startup with `ERR_MODULE_NOT_FOUND`.
// See #3811 incident logs / #3818 hotfix and the regression test
// `tests/scripts-railway-nixpacks-no-escape-import.test.mts` that pins this
// rule. Vercel-side (TS handlers): esbuild bundles the shim's contents
// inline at build time, so the cross-directory import path is fine there.
//
// Runtime constraint: this module MUST use only Web-Platform APIs.
// `node:crypto` is NOT available in Vercel Edge runtime, but
// `globalThis.crypto.subtle` IS — and Node 19+ ships it too, so the seeder
// works without a polyfill.
//
// See docs/plans/2026-05-18-003-feat-simulation-trigger-and-runid-filter-plan.md
// D4 for the framing decision and D7 for why pkgFingerprint is opaque.

export const SIMULATION_TASK_KEY_PREFIX = 'forecast:simulation-task:v1';
export const SIMULATION_TASK_QUEUE_KEY = 'forecast:simulation-task-queue:v1';
export const SIMULATION_TASK_TTL_SECONDS = 4 * 60 * 60;

export const SIMULATION_OUTCOME_LATEST_KEY = 'forecast:simulation-outcome:latest';
export const SIMULATION_OUTCOME_BY_RUN_KEY_PREFIX = 'forecast:simulation-outcome:by-run';
export const SIMULATION_OUTCOME_BY_RUN_TTL_SECONDS = 24 * 60 * 60;

export const SIMULATION_PACKAGE_LATEST_KEY = 'forecast:simulation-package:latest';

// Queue-depth threshold matching run-scenario.ts; the handler returns 429
// when LLEN/ZCARD of the queue exceeds this value.
export const MAX_QUEUE_DEPTH = 100;

// runId format pinned by the seeder: epoch_ms-suffix.
export const VALID_RUN_ID_RE = /^\d{13,}-[a-z0-9-]{1,64}$/i;

export const SIMULATION_TRIGGER_RATE_LIMIT = Object.freeze({ limit: 10, window: '60 s' });

/**
 * Compute an opaque 16-hex-char fingerprint of the simulation package R2
 * object key. Used in task payloads and trigger responses so callers can
 * detect cron rotation without seeing the raw R2 path (which would leak
 * bucket layout — see #3734 review).
 *
 * Async by necessity: Web Crypto's `subtle.digest` is the only API
 * available in BOTH Vercel Edge AND Node 19+, and it is async-only.
 * Both callers (handler + worker) already run inside async functions.
 *
 * @param {string} pkgKey - R2 object key like
 *   `seed-data/forecast-traces/2026/05/18/<runId>/simulation-package.json`.
 * @returns {Promise<string>} 16-char lowercase hex. Empty string when
 *   pkgKey is empty/null (signals "no fingerprint to verify" downstream).
 */
export async function pkgFingerprint(pkgKey) {
  if (!pkgKey || typeof pkgKey !== 'string') return '';
  const data = new TextEncoder().encode(pkgKey);
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hashBuffer);
  let hex = '';
  for (let i = 0; i < 8; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}
