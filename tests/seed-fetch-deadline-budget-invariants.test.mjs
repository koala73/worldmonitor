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
    // #5859 review: the fetch-order read is a SECOND consumer of the same soft
    // budget, bounded to MIN_REQUEST_BUDGET_MS before the first DOC request.
    // Model the two paths additively (see docs/solutions/design-patterns/
    // primary-fallback-inversion-budget-transfer.md): even with the ordering
    // read fully spent, the paced sweep must still fit ahead of the final
    // request's response budget.
    assert.ok(
      minRequest + (7 * requestDelay) + minRequest < soft,
      'the bounded ordering read plus 8 paced DOC calls must fit the soft budget additively',
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
      HAPI_FALLBACK_BUDGET_MS,
    } = await import('../scripts/seed-conflict-intel.mjs');
    const {
      HAPI_HDX_METADATA_TIMEOUT_MS,
      HAPI_HDX_SNAPSHOT_TIMEOUT_MS,
      HAPI_MAX_PAGES,
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

    // HAPI runs inside the same parallel auxiliary phase as the GDELT sweep, so
    // the two occupy the same window (max), they do not stack (sum). It has two
    // routes since #7658 made the HDX snapshot the authoritative channel.
    const HAPI_DIRECT_REQUEST_MS = 15_000;
    const HAPI_GLOBAL_SWEEPS = 2;
    // Primary route: the snapshot, worst at the January boundary — 60s metadata
    // then the current and previous annual downloads. The two global sweeps and
    // the fan-out then cost NOTHING; they filter rows already in memory.
    const HAPI_SNAPSHOT_WORST_MS = HAPI_HDX_METADATA_TIMEOUT_MS
      + 2 * HAPI_HDX_SNAPSHOT_TIMEOUT_MS;
    // Demoted route: the snapshot may spend almost HAPI_FALLBACK_BUDGET_MS
    // before failing. After demotion, every API page launch shares one new
    // absolute deadline. One page can still be in flight when that deadline
    // closes, but no later page from either global sweep or the country fallback
    // may launch. This is the bound the injected-clock pagination test proves.
    const HAPI_DEMOTED_API_WINDOW_MS = HAPI_FALLBACK_BUDGET_MS + HAPI_DIRECT_REQUEST_MS;
    const HAPI_DEMOTED_WORST_MS = HAPI_FALLBACK_BUDGET_MS + HAPI_DEMOTED_API_WINDOW_MS;
    const HAPI_WORST_MS = Math.max(HAPI_SNAPSHOT_WORST_MS, HAPI_DEMOTED_WORST_MS);

    // The envelope every HAPI comment in the seeder re-derives against. Assert
    // it DIRECTLY: the previous form of this check (worst < ungated-stack)
    // reduced algebraically to HAPI_FALLBACK_BUDGET_MS < HAPI_SNAPSHOT_WORST_MS
    // and would still have passed with the budget raised to 200s, so it no
    // longer pinned the constant its own prose claimed to pin.
    const HAPI_ENVELOPE_MS = 315_000;
    assert.ok(HAPI_SNAPSHOT_WORST_MS <= HAPI_ENVELOPE_MS,
      `snapshot route ${HAPI_SNAPSHOT_WORST_MS}ms must fit the ${HAPI_ENVELOPE_MS}ms envelope`);
    assert.ok(HAPI_DEMOTED_WORST_MS <= HAPI_ENVELOPE_MS,
      `demoted route ${HAPI_DEMOTED_WORST_MS}ms (demotion cutoff + one shared page-launch window) must fit the ${HAPI_ENVELOPE_MS}ms envelope`);
    // The demotion gate is what keeps those two routes from becoming one sum: a
    // snapshot that fails only AFTER burning its own timeouts has already spent
    // the tick, so the seeder fails closed instead of putting the sweeps behind
    // the full snapshot cost.
    const HAPI_UNGATED_SWEEP_MS = HAPI_GLOBAL_SWEEPS * HAPI_MAX_PAGES * HAPI_DIRECT_REQUEST_MS;
    const HAPI_UNGATED_STACK_MS = HAPI_SNAPSHOT_WORST_MS
      + HAPI_UNGATED_SWEEP_MS
      + HAPI_DIRECT_REQUEST_MS;
    assert.ok(HAPI_UNGATED_STACK_MS > HAPI_ENVELOPE_MS,
      'this guard is only meaningful while an ungated stack would actually breach the envelope');

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
