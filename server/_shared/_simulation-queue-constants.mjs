// Shared queue / outcome constants + opaque fingerprint helper for the
// simulation pipeline. Single source of truth imported by:
//   - scripts/seed-forecasts.mjs (the auto-trigger seeder + worker)
//   - server/_shared/simulation-queue.ts (the HTTP-trigger handler module)
//
// The shim is .mjs (not .ts) so the Node 22 seeder can import it natively
// without a tsx loader. The TS module imports via a sibling .d.ts (no
// `// @ts-expect-error` needed).
//
// See docs/plans/2026-05-18-003-feat-simulation-trigger-and-runid-filter-plan.md
// D4 for the framing decision and D7 for why pkgFingerprint is opaque.

import { createHash } from 'node:crypto';

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
 * @param {string} pkgKey - R2 object key like
 *   `seed-data/forecast-traces/2026/05/18/<runId>/simulation-package.json`.
 * @returns {string} 16-char lowercase hex. Empty string when pkgKey is
 *   empty/null (signals "no fingerprint to verify" downstream).
 */
export function pkgFingerprint(pkgKey) {
  if (!pkgKey || typeof pkgKey !== 'string') return '';
  return createHash('sha256').update(pkgKey).digest('hex').slice(0, 16);
}
