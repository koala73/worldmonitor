// @ts-check
// Regime drift history recorder. Phase 3 PR1.
//
// Append-only per-region transition log. Each entry captures a regime
// change moment (previous label → current label) with the timestamp,
// transition driver (if known), and the snapshot_id that materialized it.
// The list is stored at `intelligence:regime-history:v1:{regionId}` and
// capped at REGIME_HISTORY_MAX via LTRIM so it never grows unbounded.
//
// Writes happen from the seed-regional-snapshots main loop after
// persistSnapshot success, but ONLY when diff.regime_changed is set.
// Steady-state snapshots don't produce entries, so the log is a pure
// transition stream and callers can compute drift windows over it
// without filtering.
//
// Never throws. Never blocks snapshot persist. Best-effort — if Redis
// is unavailable the entry is dropped, next genuine regime change will
// write a new one.
//
// Publisher is dependency-injected via opts.publishEntry so unit tests
// exercise the full build/publish pipeline offline.

import { getRedisCredentials } from '../_seed-utils.mjs';

export const REGIME_HISTORY_KEY_PREFIX = 'intelligence:regime-history:v1:';
export const REGIME_HISTORY_MAX = 100;
// 6 months of 6h cadence with assume-every-change = 720 entries; 100 is a
// tighter cap that still covers multiple months of realistic transition
// counts (most regions change 2-10 times a month).

// ── Pure builder ─────────────────────────────────────────────────────────────

/**
 * Build the RegimeTransition entry that should be appended to the region's
 * history log. Returns null when the diff does not describe a genuine
 * regime change — the caller must check for null before publishing.
 *
 * @param {{ id: string, label?: string }} region
 * @param {import('../../shared/regions.types.js').RegionalSnapshot} snapshot
 * @param {import('../../shared/regions.types.js').SnapshotDiff} diff
 * @returns {{
 *   region_id: string,
 *   label: string,
 *   previous_label: string,
 *   transitioned_at: number,
 *   transition_driver: string,
 *   snapshot_id: string,
 * } | null}
 */
export function buildTransitionEntry(region, snapshot, diff) {
  if (!region || !snapshot || !diff) return null;
  const rc = diff.regime_changed;
  if (!rc?.to) return null;

  return {
    region_id: region.id,
    label: String(rc.to),
    previous_label: String(rc.from ?? ''),
    // Prefer the seed's transitioned_at (built by buildRegimeState) so
    // the history entry's timestamp matches the snapshot's regime block;
    // fall back to generated_at or now() if upstream is missing.
    transitioned_at: Number(
      snapshot.regime?.transitioned_at
        || snapshot.generated_at
        || Date.now(),
    ),
    transition_driver: String(snapshot.regime?.transition_driver ?? ''),
    snapshot_id: String(snapshot.meta?.snapshot_id ?? ''),
  };
}

// ── Redis ops abstraction (for testability) ──────────────────────────────────

/**
 * @typedef {{
 *   lpush: (key: string, value: string) => Promise<boolean>,
 *   ltrim: (key: string, start: number, stop: number) => Promise<boolean>,
 * }} RegimeHistoryRedisOps
 */

/**
 * Publish one transition entry through injected Redis operations. Exported
 * for tests; the default publisher below is a thin wrapper that binds real
 * Upstash REST calls and delegates here.
 *
 * Flow:
 *   1. LPUSH entry onto intelligence:regime-history:v1:{region}
 *   2. LTRIM to keep only the most recent REGIME_HISTORY_MAX entries
 *
 * Never throws. Returns the outcome:
 *   { pushed: true, trimmed: true }   — happy path
 *   { pushed: true, trimmed: false }  — LPUSH ok but LTRIM failed
 *   { pushed: false, trimmed: false } — LPUSH failed
 *
 * @param {object} entry
 * @param {RegimeHistoryRedisOps} ops
 * @returns {Promise<{ pushed: boolean, trimmed: boolean }>}
 */
export async function publishTransitionWithOps(entry, ops) {
  if (!entry?.region_id) return { pushed: false, trimmed: false };
  const key = `${REGIME_HISTORY_KEY_PREFIX}${entry.region_id}`;
  const payload = JSON.stringify(entry);

  let pushed = false;
  try {
    pushed = await ops.lpush(key, payload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[regime-history] LPUSH threw for ${entry.region_id}: ${msg}`);
    return { pushed: false, trimmed: false };
  }
  if (!pushed) return { pushed: false, trimmed: false };

  // LTRIM 0..N-1 keeps the N most recent entries (LPUSH writes to head).
  let trimmed = false;
  try {
    trimmed = await ops.ltrim(key, 0, REGIME_HISTORY_MAX - 1);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[regime-history] LTRIM threw for ${entry.region_id}: ${msg}`);
    // Leave pushed=true — the entry landed even if trim failed. The next
    // cycle's trim will enforce the cap eventually.
  }
  return { pushed, trimmed };
}

// ── Default Upstash publisher ────────────────────────────────────────────────

async function upstashLpush(url, token, key, value) {
  const resp = await fetch(
    `${url}/lpush/${encodeURIComponent(key)}/${encodeURIComponent(value)}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!resp.ok) return false;
  const json = await resp.json().catch(() => null);
  return typeof json?.result === 'number';
}

async function upstashLtrim(url, token, key, start, stop) {
  const resp = await fetch(
    `${url}/ltrim/${encodeURIComponent(key)}/${start}/${stop}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    },
  );
  return resp.ok;
}

/**
 * @param {object} entry
 * @returns {Promise<{ pushed: boolean, trimmed: boolean }>}
 */
async function defaultPublishEntry(entry) {
  let creds;
  try {
    creds = getRedisCredentials();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[regime-history] getRedisCredentials failed: ${msg}`);
    return { pushed: false, trimmed: false };
  }
  /** @type {RegimeHistoryRedisOps} */
  const ops = {
    lpush: (key, value) => upstashLpush(creds.url, creds.token, key, value),
    ltrim: (key, start, stop) => upstashLtrim(creds.url, creds.token, key, start, stop),
  };
  return publishTransitionWithOps(entry, ops);
}

// ── Public entry ────────────────────────────────────────────────────────────

/**
 * Record a regime transition if the diff contains one. Ship-silent on
 * no-op (no regime change) or failure. Never throws, never blocks.
 *
 * @param {{ id: string, label?: string }} region
 * @param {import('../../shared/regions.types.js').RegionalSnapshot} snapshot
 * @param {import('../../shared/regions.types.js').SnapshotDiff} diff
 * @param {{ publishEntry?: (entry: object) => Promise<{ pushed: boolean, trimmed: boolean }> }} [opts]
 * @returns {Promise<{ recorded: boolean, entry: object | null, pushed: boolean, trimmed: boolean }>}
 */
export async function recordRegimeTransition(region, snapshot, diff, opts = {}) {
  const entry = buildTransitionEntry(region, snapshot, diff);
  if (!entry) {
    return { recorded: false, entry: null, pushed: false, trimmed: false };
  }

  const publisher = opts.publishEntry ?? defaultPublishEntry;
  try {
    const result = await publisher(entry);
    return { recorded: result.pushed, entry, pushed: result.pushed, trimmed: result.trimmed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[regime-history] ${region.id}: publish threw: ${msg}`);
    return { recorded: false, entry, pushed: false, trimmed: false };
  }
}
