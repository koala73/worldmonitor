// Regression guard for issue #4864. Three seeders tripped the #4786 fetch-phase
// deadline (raceFetchDeadline in _seed-utils.mjs: default = lockTtlMs 120s + 120s
// margin = 240s) on legitimate slow-retry runs, exiting 75 (a Railway "crash"
// email) — and seed-supply-chain-trade additionally lost its last-good data
// because it never republished and its 8h TTL only buffered one 6h cron cycle.
//
// The fixes are config values sized to each seeder's real worst-case runtime and
// cron cadence. These invariants pin those values so a future edit can't silently
// re-shrink them below the runtime/cadence and reopen the bug. Values are read
// from source text (the seeders execute Redis at import, so we don't import them).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const scriptsDir = fileURLToPath(new URL('../scripts/', import.meta.url));
const read = (f) => readFileSync(scriptsDir + f, 'utf8');
const num = (s) => Number(String(s).replace(/_/g, ''));

// Pull `name: 12_345` / `const NAME = 12345;` numeric literals out of source.
function optValue(src, key) {
  const m = src.match(new RegExp(`${key}\\s*[:=]\\s*(\\d[\\d_]*)`));
  return m ? num(m[1]) : null;
}

const FETCH_PHASE_MARGIN_MS = 120_000; // _seed-utils.mjs FETCH_PHASE_DEADLINE_MARGIN_MS
const deadlineFromLock = (lockMs) => lockMs + FETCH_PHASE_MARGIN_MS;

describe('seed fetch-phase deadline & TTL invariants (issue #4864)', () => {
  it('gdelt-intel: soft budget fires before the hard deadline, leaving merge+publish headroom', () => {
    const src = read('seed-gdelt-intel.mjs');
    const soft = optValue(src, 'FETCH_SOFT_BUDGET_MS');
    const minRequest = optValue(src, 'MIN_REQUEST_BUDGET_MS');
    const requestDelay = optValue(src, 'GDELT_REQUEST_DELAY_MS');
    const hardDeadline = optValue(src, 'RUN_SEED_FETCH_PHASE_TIMEOUT_MS');
    assert.ok(soft, 'FETCH_SOFT_BUDGET_MS must be defined');
    assert.ok(hardDeadline, 'RUN_SEED_FETCH_PHASE_TIMEOUT_MS must be defined');
    // The soft budget must trip well before the explicit hard deadline so the
    // cache-merge + publish complete inside it.
    assert.ok(soft + 60_000 <= hardDeadline, `soft budget ${soft}ms + merge headroom must stay under the ${hardDeadline}ms hard deadline`);
    assert.ok(minRequest && minRequest > 0 && minRequest < soft, 'MIN_REQUEST_BUDGET_MS must be a positive fraction of the soft budget');
    assert.ok(requestDelay && requestDelay >= 5_000, 'healthy DOC requests must remain evenly paced');
    assert.ok(
      (7 * requestDelay) + minRequest < soft,
      '8 paced DOC calls must leave response-time budget before the final request starts',
    );
  });

  it('grocery-basket: lock/deadline covers its ~600s degraded serial runtime (24 serial countries)', () => {
    const src = read('seed-grocery-basket.mjs');
    const lock = optValue(src, 'lockTtlMs');
    assert.ok(lock, 'grocery-basket runSeed must set lockTtlMs (default 120s → 240s deadline is below its serial runtime)');
    // Degraded run ≈ 600s (24 countries × ~25s critical path). Deadline must clear it.
    assert.ok(deadlineFromLock(lock) >= 600_000, `deadline ${deadlineFromLock(lock)}ms must cover the ~600s degraded runtime`);
  });

  it('supply-chain-trade: lock/deadline covers the WTO ~10min budget so runs complete + republish', () => {
    // This is the data-loss fix: fetchAll must reach atomicPublish (republish) so the
    // canonical key stays alive / is recreatable, instead of always tripping the 240s
    // deadline before publishing (which made "manual seed required" loss permanent).
    const src = read('seed-supply-chain-trade.mjs');
    const lock = optValue(src, 'lockTtlMs');
    assert.ok(lock, 'supply-chain runSeed must set lockTtlMs (WTO reporter scan far exceeds the 240s default)');
    assert.ok(deadlineFromLock(lock) >= 600_000, `deadline ${deadlineFromLock(lock)}ms must clear the ~10min WTO design budget`);
  });

  it('conflict-intel: GDELT fallback sweep worst case fits its lock and deadline (issue #5140)', async () => {
    // seed-conflict-intel is import-safe (runSeed is argv-guarded), so unlike the
    // seeders above we assert against its real exported constants, not source text.
    const {
      GDELT_SWEEP_BUDGET_MS,
      GDELT_COUNTRY_FETCH_OPTS,
      ACLED_INTEL_LOCK_TTL_MS,
    } = await import('../scripts/seed-conflict-intel.mjs');
    const {
      HAPI_HDX_METADATA_TIMEOUT_MS,
      HAPI_HDX_SNAPSHOT_TIMEOUT_MS,
    } = await import('../scripts/_conflict-hapi.mjs');
    const { GDELT_BULK_WORST_NETWORK_MS } = await import('../scripts/_conflict-gdelt-bulk.mjs');

    // The transport rejects same-route retries; this caller pins that contract.
    assert.equal(GDELT_COUNTRY_FETCH_OPTS.maxRetries, 0,
      'direct same-route retries must remain disabled');

    // One route is selected. Direct legs overlap; proxy curls are synchronous
    // and therefore serialize across the batch.
    const DIRECT_LEG_MS = 15_000;
    const PROXY_CURL_CEILING_MS = 20_000;
    const SWEEP_CONCURRENCY = 4;
    const worstBatch = Math.max(
      DIRECT_LEG_MS,
      SWEEP_CONCURRENCY * GDELT_COUNTRY_FETCH_OPTS.proxyMaxAttempts * PROXY_CURL_CEILING_MS,
    );

    // HAPI bot-block fallback worst at the January boundary: one 15s direct
    // request, 60s metadata, then the current and previous annual snapshots.
    // It runs inside the same parallel auxiliary phase as the GDELT sweep, so
    // the two occupy the same window (max), they do not stack (sum).
    const HAPI_DIRECT_REQUEST_MS = 15_000;
    const HAPI_WORST_MS = HAPI_DIRECT_REQUEST_MS
      + HAPI_HDX_METADATA_TIMEOUT_MS
      + 2 * HAPI_HDX_SNAPSHOT_TIMEOUT_MS;
    const EXTRA_KEY_WRITE_SLACK_MS = 30_000;
    const worstFetchAttempt = Math.max(HAPI_WORST_MS, GDELT_SWEEP_BUDGET_MS + worstBatch)
      + GDELT_BULK_WORST_NETWORK_MS
      + EXTRA_KEY_WRITE_SLACK_MS;

    // runSeed invariant: a healthy seeder never outlives its own lock…
    assert.ok(worstFetchAttempt <= ACLED_INTEL_LOCK_TTL_MS,
      `worst fetch attempt ${worstFetchAttempt}ms must fit the ${ACLED_INTEL_LOCK_TTL_MS}ms lock`);
    // …and the lock-derived deadline (lock + 120s margin) then clears it a fortiori.
    assert.ok(worstFetchAttempt <= deadlineFromLock(ACLED_INTEL_LOCK_TTL_MS),
      `worst fetch attempt ${worstFetchAttempt}ms must fit the ${deadlineFromLock(ACLED_INTEL_LOCK_TTL_MS)}ms fetch deadline`);
    // The runSeed call must actually wire the exported lock value.
    const src = read('seed-conflict-intel.mjs');
    assert.ok(/lockTtlMs:\s*ACLED_INTEL_LOCK_TTL_MS/.test(src),
      'runSeed must pass lockTtlMs: ACLED_INTEL_LOCK_TTL_MS');
  });
});
