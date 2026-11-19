#!/usr/bin/env node

// Retired. conflict:iran-events:v1 is produced every 10 minutes by ais-relay
// (Middle East strike feed: Telegram + GDELT, scripts/lib/middle-east-strikes.cjs).
// This was the manual LiveUAMap importer; run now it would overwrite the live
// feed with a stale dump, so it never writes. The file stays only so the dormant
// seed-iran-events Railway service exits cleanly until it is deleted.
const startedAt = Date.now();
console.log('[iran-events] Retired: conflict:iran-events:v1 is produced by ais-relay (telegram-strikes-v1). Nothing to do.');
console.log(`\n=== Done (${Date.now() - startedAt}ms) ===`);
process.exit(0);
