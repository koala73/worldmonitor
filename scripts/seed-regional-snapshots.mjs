#!/usr/bin/env node
// @ts-check
/**
 * Regional Intelligence snapshot seeder.
 *
 * Computes a RegionalSnapshot per region using deterministic scoring across
 * seven balance axes, derives a regime label, scores actors, evaluates
 * structured trigger thresholds, builds normalized scenario sets, resolves
 * pre-built transmission templates, and persists to Redis with idempotency.
 *
 * Phase 1 (PR2): LLM narrative layer added. One structured-JSON call per
 * region via generateRegionalNarrative(), ship-empty on any failure. The
 * 'global' region is skipped inside the generator. Provider + model flow
 * through SnapshotMeta.narrative_provider / narrative_model.
 *
 * Architecture: docs/internal/pro-regional-intelligence-upgrade.md
 * Engineering:  docs/internal/pro-regional-intelligence-appendix-engineering.md
 * Scoring:      docs/internal/pro-regional-intelligence-appendix-scoring.md
 *
 * Run via the seed bundle (recommended) or directly:
 *   node scripts/seed-regional-snapshots.mjs
 */

import { pathToFileURL } from 'node:url';

import { loadEnvFile, getRedisCredentials, writeExtraKeyWithMeta } from './_seed-utils.mjs';
// Use scripts/shared mirror rather than the repo-root shared/ folder: the
// Railway bundle service sets rootDirectory=scripts, so `../shared/` resolves
// to filesystem / on deploy and the import fails with ERR_MODULE_NOT_FOUND.
// scripts/shared/* is kept in sync with shared/* via tests.
import { REGIONS, GEOGRAPHY_VERSION } from './shared/geography.js';

import { computeBalanceVector, SCORING_VERSION } from './regional-snapshot/balance-vector.mjs';
import { buildRegimeState } from './regional-snapshot/regime-derivation.mjs';
import { scoreActors } from './regional-snapshot/actor-scoring.mjs';
import { evaluateTriggers } from './regional-snapshot/trigger-evaluator.mjs';
import { buildScenarioSets } from './regional-snapshot/scenario-builder.mjs';
import { resolveTransmissions } from './regional-snapshot/transmission-templates.mjs';
import { collectEvidence } from './regional-snapshot/evidence-collector.mjs';
import { buildPreMeta, buildFinalMeta } from './regional-snapshot/snapshot-meta.mjs';
import { diffRegionalSnapshot, inferTriggerReason } from './regional-snapshot/diff-snapshot.mjs';
import { persistSnapshot, readLatestSnapshot } from './regional-snapshot/persist-snapshot.mjs';
import { ALL_INPUT_KEYS, ALL_META_KEYS } from './regional-snapshot/freshness.mjs';
import { generateSnapshotId } from './regional-snapshot/_helpers.mjs';
import { generateRegionalNarrative, emptyNarrative } from './regional-snapshot/narrative.mjs';
import { emitRegionalAlerts } from './regional-snapshot/alert-emitter.mjs';
import { buildMobilityState } from './regional-snapshot/mobility.mjs';

loadEnvFile(import.meta.url);

const SEED_META_KEY = 'intelligence:regional-snapshots';

/**
 * Read every input key + every metaKey companion in a single pipeline.
 * metaKeys carry {fetchedAt, recordCount} for inputs whose data payload
 * has no top-level timestamp (mobility sources). See freshness.mjs.
 *
 * @returns {Promise<{ sources: Record<string, any>, metaSources: Record<string, any> }>}
 */
async function readAllInputs() {
  const { url, token } = getRedisCredentials();
  const keys = [...ALL_INPUT_KEYS, ...ALL_META_KEYS];
  const pipeline = keys.map((k) => ['GET', k]);
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(pipeline),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Redis pipeline read: HTTP ${resp.status}`);
  const results = await resp.json();

  /** @type {Record<string, any>} */
  const sources = {};
  /** @type {Record<string, any>} */
  const metaSources = {};
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const target = i < ALL_INPUT_KEYS.length ? sources : metaSources;
    const raw = results[i]?.result;
    if (raw === null || raw === undefined) {
      target[key] = null;
      continue;
    }
    try {
      target[key] = JSON.parse(raw);
    } catch {
      target[key] = null;
    }
  }
  return { sources, metaSources };
}

/**
 * Run the full compute pipeline for one region in the canonical order.
 *
 *   1. (sources already read by caller)
 *   2. pre_meta
 *   3. balance vector
 *   4. actors
 *   5. triggers (BEFORE scenarios)
 *   6. scenarios (normalized)
 *   7. transmissions
 *   8. mobility (v1 adapter — airports, airspace, reroute_intensity, NOTAMs)
 *   9. evidence
 *   10. snapshot_id
 *   11. read previous + derive regime
 *   12. build snapshot-for-prompt (no narrative yet)
 *   13. LLM narrative call (ship-empty on failure; skipped for 'global')
 *   14. splice narrative into tentative snapshot
 *   15. diff → trigger_reason
 *   16. final_meta with narrative_provider/narrative_model
 */
async function computeSnapshot(regionId, sources, metaSources = {}) {
  // Step 2: pre-meta (metaSources carries seed-meta:*.fetchedAt for inputs
  // whose data payloads have no top-level timestamp — see freshness.mjs).
  const { pre } = buildPreMeta(sources, SCORING_VERSION, GEOGRAPHY_VERSION, metaSources);

  // Step 3: balance vector
  const { vector: balance } = computeBalanceVector(regionId, sources);

  // Step 4: actors
  const { actors, edges } = scoreActors(regionId, sources);

  // Step 5: triggers (before scenarios)
  const triggers = evaluateTriggers(regionId, sources, balance);

  // Step 6: scenarios (normalized to 1.0 per horizon)
  const scenarioSets = buildScenarioSets(regionId, sources, triggers);

  // Step 7: transmissions (matched to active triggers)
  const transmissionPaths = resolveTransmissions(regionId, triggers);

  // Step 8: mobility v1 — adapters over existing Redis inputs:
  // aviation:delays:{faa,intl}, aviation:notam:closures:v2,
  // intelligence:gpsjam:v2, military:flights:v1. Pure, never throws.
  // See Phase 2 PR2 notes in scripts/regional-snapshot/mobility.mjs.
  const mobility = buildMobilityState(regionId, sources);

  // Step 9: evidence chain
  const evidence = collectEvidence(regionId, sources);

  // Step 10: snapshot_id
  const snapshotId = generateSnapshotId();

  // Step 11: read previous + derive regime. Must happen before narrative
  // generation because the prompt consumes the regime label.
  const previous = await readLatestSnapshot(regionId).catch(() => null);
  const previousLabel = previous?.regime?.label ?? '';
  const regime = buildRegimeState(balance, previousLabel, '');

  // Step 12: snapshot-shaped input for the narrative prompt. The narrative
  // generator reads regime/balance/actors/scenarios/triggers/evidence from
  // this object and does NOT inspect `meta` or the placeholder narrative.
  // Meta here is a throwaway — the real meta is built after diff so
  // trigger_reason and narrative_* can flow in together.
  const snapshotForPrompt = {
    region_id: regionId,
    generated_at: Date.now(),
    meta: buildFinalMeta(pre, { snapshot_id: snapshotId, trigger_reason: 'scheduled_6h' }),
    regime,
    balance,
    actors,
    leverage_edges: edges,
    scenario_sets: scenarioSets,
    transmission_paths: transmissionPaths,
    triggers,
    mobility,
    evidence,
    narrative: emptyNarrative(),
  };

  // Step 13: LLM narrative. Ship-empty on any failure — the snapshot remains
  // valuable without the narrative, and the narrative generator itself
  // never throws. 'global' is skipped inside the generator.
  const region = REGIONS.find((r) => r.id === regionId);
  const narrativeResult = region
    ? await generateRegionalNarrative(region, snapshotForPrompt, evidence)
    : { narrative: emptyNarrative(), provider: '', model: '' };

  // Step 14: tentative snapshot with the real narrative spliced in.
  const tentativeSnapshot = {
    ...snapshotForPrompt,
    narrative: narrativeResult.narrative,
  };

  // Step 15: diff against previous for trigger_reason inference
  const diff = diffRegionalSnapshot(previous, tentativeSnapshot);
  const triggerReason = inferTriggerReason(diff);

  // Step 16: final_meta with diff-derived trigger_reason and narrative metadata
  const finalMeta = buildFinalMeta(pre, {
    snapshot_id: snapshotId,
    trigger_reason: triggerReason,
    narrative_provider: narrativeResult.provider,
    narrative_model: narrativeResult.model,
  });

  // Return the snapshot WITHOUT the diff. The diff is a runtime artifact for
  // alert emission; persisting it would leak a non-RegionalSnapshot field into
  // Redis and break Phase 1 proto codegen consumers.
  /** @type {import('../shared/regions.types.js').RegionalSnapshot} */
  const snapshot = { ...tentativeSnapshot, meta: finalMeta };
  return { snapshot, diff };
}

async function main() {
  const t0 = Date.now();
  console.log(`[regional-snapshots] Starting compute for ${REGIONS.length} regions`);

  // Step 1: read all inputs once (shared across regions), plus seed-meta
  // companions for inputs whose payloads lack top-level timestamps.
  const { sources, metaSources } = await readAllInputs();
  const presentKeys = Object.entries(sources).filter(([, v]) => v !== null).length;
  const presentMetaKeys = Object.entries(metaSources).filter(([, v]) => v !== null).length;
  console.log(`[regional-snapshots] Read inputs: ${presentKeys}/${ALL_INPUT_KEYS.length} keys present, ${presentMetaKeys}/${ALL_META_KEYS.length} meta keys present`);

  let persisted = 0;
  let skipped = 0;
  let failed = 0;
  const summary = [];
  const failedRegions = [];

  for (const region of REGIONS) {
    try {
      const { snapshot, diff } = await computeSnapshot(region.id, sources, metaSources);
      const result = await persistSnapshot(snapshot);
      if (result.persisted) {
        persisted += 1;
        summary.push({
          region: region.id,
          regime: snapshot.regime.label,
          confidence: snapshot.meta.snapshot_confidence,
          active_triggers: snapshot.triggers.active.length,
          trigger_reason: snapshot.meta.trigger_reason,
        });
        console.log(`[${region.id}] persisted regime=${snapshot.regime.label} confidence=${snapshot.meta.snapshot_confidence} triggers=${snapshot.triggers.active.length} reason=${snapshot.meta.trigger_reason}`);

        // Emit state-change alerts for this diff. Best-effort — never blocks
        // or throws out of the main loop. Alerts are deduped on a 6h window
        // by wm:notif:scan-dedup:{eventType}:{hash}, matching the cron cadence.
        try {
          const alertResult = await emitRegionalAlerts(region, snapshot, diff);
          if (alertResult.events.length > 0) {
            console.log(`[${region.id}] alerts: ${alertResult.enqueued}/${alertResult.events.length} enqueued`);
          }
        } catch (alertErr) {
          const alertMsg = /** @type {any} */ (alertErr)?.message ?? alertErr;
          console.warn(`[${region.id}] alert emitter threw: ${alertMsg}`);
        }
      } else {
        skipped += 1;
        console.log(`[${region.id}] skipped: ${result.reason}`);
      }
    } catch (err) {
      failed += 1;
      failedRegions.push({ region: region.id, error: String(/** @type {any} */ (err)?.message ?? err) });
      console.error(`[${region.id}] FAILED: ${/** @type {any} */ (err)?.message ?? err}`);
    }
  }

  // Health policy:
  //   1. persisted > 0 && failed === 0: write the fresh summary + seed-meta.
  //   2. persisted === 0 && failed === 0: all regions dedup-skipped (e.g., a
  //      retry within the 15min idempotency bucket). Preserve the prior good
  //      summary by skipping the write entirely. api/health.js classifies an
  //      empty `regions: []` + `recordCount: 0` as EMPTY_DATA which flips the
  //      overall health to red, so overwriting on a no-op retry is actively
  //      harmful. The 12h maxStaleMin budget lets the next full run refresh
  //      the payload naturally.
  //   3. failed > 0: skip the meta write so /api/health flips to STALE after
  //      the maxStaleMin budget on persistent degradation instead of silently
  //      reporting OK. The bundle runner's freshness gate retries next cycle.
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (failed === 0 && persisted > 0) {
    const ttlSec = 12 * 60 * 60; // 12h, 2x the 6h cron cadence
    await writeExtraKeyWithMeta(
      `intelligence:regional-snapshots:summary:v1`,
      { regions: summary, generatedAt: Date.now() },
      ttlSec,
      persisted,
      `seed-meta:${SEED_META_KEY}`,
      ttlSec,
    );
    console.log(`[regional-snapshots] Done in ${elapsed}s: persisted=${persisted} skipped=${skipped} failed=0`);
    return;
  }

  if (failed === 0) {
    // All regions dedup-skipped. Preserve the prior summary and return cleanly.
    console.log(`[regional-snapshots] Done in ${elapsed}s: persisted=0 skipped=${skipped} failed=0 (all dedup-skipped, prior summary preserved)`);
    return;
  }

  console.error(`[regional-snapshots] Done in ${elapsed}s: persisted=${persisted} skipped=${skipped} failed=${failed}`);
  for (const f of failedRegions) {
    console.error(`  [${f.region}] ${f.error}`);
  }
  console.error('[regional-snapshots] Skipping seed-meta write due to partial failure. /api/health will reflect degradation after 12h.');
  process.exit(1);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`PUBLISH FAILED: ${err?.message || err}`);
    process.exit(1);
  });
}

export { main, computeSnapshot, readAllInputs };
