// Canonical CISS content-age budget — shared by the server RPC (get-eu-fsi.ts)
// and the panel (FSIPanel.ts) so the user-facing `stale` flag is computed
// against ONE threshold.
//
// The true source of truth is the seeder: `CISS_MAX_CONTENT_AGE_MIN` in
// scripts/seed-fsi-eu.mjs, which drives the /api/health STALE_CONTENT alarm.
// This module mirrors it because the seeder is plain `.mjs` (runs un-bundled
// on Railway) and cannot be imported by TypeScript app/server code.
// tests/ciss-stale-threshold-consistency.test.mjs asserts the two never drift.
//
// See issue #3845.
export const CISS_STALE_THRESHOLD_DAYS = 10;
export const CISS_STALE_THRESHOLD_MS = CISS_STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
