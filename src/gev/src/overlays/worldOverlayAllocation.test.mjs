import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LOCAL_OVERLAY_COHORT_LIMIT } from '../data/localGeojson.js';
import { FIRMS_AMBIENT_COHORT_LIMIT } from '../data/firmsLabels.js';
import { vesselOverlayCohortLimit } from '../data/vesselLabels.js';
import { CCTV_AMBIENT_CARD_MAX } from '../data/cctvLod.js';
import { AMBIENT_CARD_COLLISION_CAPACITY } from './worldOverlay.js';
import { EARTHQUAKE_OVERLAY_COHORT_LIMIT } from '../data/earthquakes.js';
import { ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT } from '../data/rocketLaunches.js';
import { RADIO_OVERLAY_COHORT_LIMIT } from '../data/radio.js';
import { CABLE_REFERENCE_LABEL_WINNER_CAP } from '../data/telegeographySubmarineCables.js';
import { isCalibratedAllocationRuntime } from '../../scripts/run-unit-tests.mjs';

/**
 * Phase-2 entry gate: a steady moving-source frame must not allocate in
 * proportion to the cohort it projects. The measurement runs in a
 * `--expose-gc` child (`worldOverlayAllocation.worker.mjs`) so the whole suite
 * does not need the flag, and the child reports GC-bracketed heap deltas over
 * ten chunks (a chunk delta is `allocated - collected`, so it can only ever
 * under-report; the median is immune to a single anomalous chunk).
 *
 * Budgets are per FRAME and per CANDIDATE, never per painted entry: above a
 * domain's `collisionCapacity` the painted count saturates while candidate
 * work keeps scaling, so a per-painted-entry budget silently relaxes exactly
 * where the cohort gets expensive.
 *
 * Two generic workloads bracket that boundary (`collisionCapacity` is 96),
 * and the Phase-2 workload registers both production local source ids with
 * their card entry shape and production-sized per-source cohorts:
 *
 *   profile              | entries | candidates | painted | median B/frame | B/candidate | frame budget
 *   ---------------------+---------+------------+---------+----------------+-------------+-------------
 *   generic below cap    |      60 |         60 |      60 |           3182 |        53.0 |       4,100
 *   generic above cap    |     250 |        250 |      96 |          10022 |        40.1 |      13,000
 *   local infrastructure |     320 |        320 |     192 |          39478 |       123.4 |      49,000
 *   Phase 3 + FIRMS      |     338 |        338 |     210 |          41220 |       122.0 |      53,600
 *   Phase 3 + vessels    |     451 |        451 |     311 |          67252 |       149.1 |      87,500
 *   Phase 3 + tracked    |     451 |        451 |     310 |          66642 |       147.8 |      86,700
 *   Phase 4 + CCTV       |     492 |        492 | 310/312 |     78742/97696 | 160.0/198.6 |     102,400
 *   rocket missions      |      48 |         48 |      24 |           5195 |       108.2 |       6,000
 *   Phase 5 pre-missions |     591 |        591 |     353 |         127815 |       216.3 |     132,000
 *   Phase 5 final        |     639 |        639 |     353 |         133769 |       209.3 |     142,000
 *   submarine cables     |     160 |        160 |      96 |          17015 |       106.3 |      19,000
 *   all-live (w/ cables) |     864 |        864 |     398 |         164711 |       190.6 |     182,000
 *   Phase 6 detection    |    5000 |       5000 |    5000 |  524191/600729 | 104.8/120.1 |     700,000
 *
 * The FIRMS/placement fixes traded the all-sources-live rows up (vessels
 * 24,975→67,252 and tracked 20,240→66,642 B/frame), still below the ~77–87 KB
 * pre-refactor base; the vessels row's 3.2% headroom under the 154 B/candidate
 * ceiling is intentional tight discipline. The budgets below
 * retain the Phase-2 4,100 / 13,000 / 49,000 frame gates; the enlarged Phase-3
 * rows carry about 30% headroom over their isolated medians. The shared
 * 154 B/candidate ceiling is intentionally the restored Phase-2 scaling
 * backstop rather than another workload-specific allowance. The vessel row
 * adds the production 1600×900 grid cohort
 * (112 ambient entries) and one protected selected card; its 311 painted count
 * demonstrates the protected item survives while ambient cards still collide.
 * The tracked row replaces that mutually exclusive selected-vessel card with
 * the production tracked-entry factory and options; its larger two-detail-line
 * footprint excludes one additional ambient card.
 *
 * The 154 B/candidate ceiling still gates every non-image workload, including
 * the production-sized 48-marker rocket-mission cohort (24 ambient winners).
 * CCTV is the documented image exception: each of its 41 ready thumbnail
 * entries (40 shipped ambient slots plus the opt-in protected active-card path) adds a
 * live source-owned frame-slot readiness read and exercises Canvas2D
 * `drawImage`. V8 exhibits two stable all-chunk JIT/IC regimes for this exact
 * workload: 160.0 or 198.6 B/raw candidate/frame. Extending warmup did not pin
 * one regime, so the image-only candidate ceiling is 210 (5.7% headroom over
 * the slower mode). The 102,400 B/frame median gate remains the primary bound
 * and the shared 154 ceiling remains unchanged for every non-image row.
 * The pre-missions Phase-5 row adds a third protected selected/tracked-lane
 * entry, exercises the military card's full three-line presentation, and
 * retains those 41 live image-slot reads. Its 216.3 B/candidate mode is gated
 * at 225 (4.0% headroom); the tighter 210 exception remains on the Phase-4 image row
 * and the 154 ceiling remains unchanged for all non-image workloads. The final
 * row adds the 48 mission candidates. Its 225 ceiling is not a mission-label
 * exception: the aggregate still performs the same 41 CCTV image-slot reads
 * and `drawImage` calls that require the documented image-inclusive ceiling;
 * the isolated mission row remains under 154 B/candidate. Cable references
 * were the depth-tested native exception when the intermediate phase rows
 * were calibrated; since the 2026-08-18 migration they publish a bounded
 * 160-label host cohort gated by their own isolated row below AND folded
 * into the recalibrated all-live aggregate (the phase3/phase4/phase5 rows
 * deliberately keep their historical pre-cable composition).
 * The all-live row adds the bounded 64 ambient Radio cluster-label
 * cohort plus one protected selected-station label; Radio supplies painted
 * winners in the saturated ambient-label domain while the selected lane
 * remains protected. Since the 2026-08-18 recalibration the row also carries
 * the 160-winner submarine-cable cohort (864 candidates total, cables winning
 * painted ambient-label slots); its 182,000 frame budget and the existing 225
 * B/candidate image-inclusive ceiling retain more than 10% headroom over the
 * measured Node 24 median/max (164,711 / 167,313 B/frame).
 *
 * The Phase-6 row activates the production detection lane at Dense/100 over a
 * deterministic 5,000-observation, 2,500 km scene. All observations exercise
 * manual projection and batched bracket paint; the shipped global-view label
 * budget keeps the rich-callout cohort bounded. Repeated clean-process probes
 * expose two stable V8/GC regimes at 524,191 and 600,729 B/frame (104.8 and
 * 120.1 B/observation/frame). The slower regime remains below the unchanged
 * 154 ceiling with 28.2% headroom, while the 700 KB frame budget carries 16.5%
 * headroom. No detection exception is taken: the larger absolute frame budget
 * is the honest cost of preserving broad reticles for 5,000 live observations.
 *
 * History: the FIRMS migration introduced `anchor +/- leaderOffset` writes on
 * every pooled placement. Those computed doubles were boxed on the shared
 * frame path and inflated the three Phase-2 medians to 12,782 / 50,022 /
 * ~101,000 B/frame. Hoisting a signed Smi offset and applying it in the painter
 * fixed that regression. A separate saturated vertical-only queue revisit was
 * then profiled and fixed before this full table was re-derived.
 */
const WORKLOADS = [
  {
    name: 'below collision capacity',
    entries: 60,
    candidates: 60,
    maxBytesPerFrame: 4100,
    saturated: false,
  },
  {
    name: 'above collision capacity',
    entries: 250,
    candidates: 250,
    maxBytesPerFrame: 13_000,
    saturated: true,
  },
  {
    name: 'with both local infrastructure sources live',
    profile: 'local-infrastructure',
    entries: LOCAL_OVERLAY_COHORT_LIMIT * 2,
    candidates: LOCAL_OVERLAY_COHORT_LIMIT * 2,
    maxBytesPerFrame: 49_000,
    saturated: true,
  },
  {
    name: 'with infrastructure and FIRMS live',
    profile: 'phase3-firms',
    entries: LOCAL_OVERLAY_COHORT_LIMIT * 2 + FIRMS_AMBIENT_COHORT_LIMIT,
    candidates: LOCAL_OVERLAY_COHORT_LIMIT * 2 + FIRMS_AMBIENT_COHORT_LIMIT,
    maxBytesPerFrame: 53_600,
    saturated: true,
    ambientCardCapacity: AMBIENT_CARD_COLLISION_CAPACITY,
  },
  {
    name: 'with infrastructure, FIRMS, and vessels live',
    profile: 'phase3-vessels',
    entries: LOCAL_OVERLAY_COHORT_LIMIT * 2 + FIRMS_AMBIENT_COHORT_LIMIT
      + vesselOverlayCohortLimit(1600, 900) + 1,
    candidates: LOCAL_OVERLAY_COHORT_LIMIT * 2 + FIRMS_AMBIENT_COHORT_LIMIT
      + vesselOverlayCohortLimit(1600, 900) + 1,
    maxBytesPerFrame: 87_500,
    saturated: true,
    ambientCardCapacity: AMBIENT_CARD_COLLISION_CAPACITY,
  },
  {
    name: 'with infrastructure, FIRMS, ambient vessels, and tracked readout live',
    profile: 'phase3-tracked',
    entries: LOCAL_OVERLAY_COHORT_LIMIT * 2 + FIRMS_AMBIENT_COHORT_LIMIT
      + vesselOverlayCohortLimit(1600, 900) + 1,
    candidates: LOCAL_OVERLAY_COHORT_LIMIT * 2 + FIRMS_AMBIENT_COHORT_LIMIT
      + vesselOverlayCohortLimit(1600, 900) + 1,
    maxBytesPerFrame: 86_700,
    saturated: true,
    ambientCardCapacity: AMBIENT_CARD_COLLISION_CAPACITY,
  },
  {
    name: 'with all Phase 3 sources and CCTV thumbnails live',
    profile: 'phase4-cctv',
    entries: LOCAL_OVERLAY_COHORT_LIMIT * 2 + FIRMS_AMBIENT_COHORT_LIMIT
      + vesselOverlayCohortLimit(1600, 900) + 1 + CCTV_AMBIENT_CARD_MAX + 1,
    candidates: LOCAL_OVERLAY_COHORT_LIMIT * 2 + FIRMS_AMBIENT_COHORT_LIMIT
      + vesselOverlayCohortLimit(1600, 900) + 1 + CCTV_AMBIENT_CARD_MAX + 1,
    maxBytesPerFrame: 102_400,
    maxBytesPerCandidatePerFrame: 210,
    saturated: true,
    ambientCardCapacity: AMBIENT_CARD_COLLISION_CAPACITY,
  },
  {
    name: 'with the bounded rocket-mission ambient cohort',
    profile: 'rocket-missions',
    entries: ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT,
    candidates: ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT,
    maxBytesPerFrame: 6_000,
    saturated: true,
  },
  {
    name: 'with final Phase 5 host sources live (pre-cable-migration surface)',
    profile: 'phase5-military',
    entries: LOCAL_OVERLAY_COHORT_LIMIT * 2 + FIRMS_AMBIENT_COHORT_LIMIT
      + vesselOverlayCohortLimit(1600, 900) + 1 + CCTV_AMBIENT_CARD_MAX + 1
      + EARTHQUAKE_OVERLAY_COHORT_LIMIT + 3,
    candidates: LOCAL_OVERLAY_COHORT_LIMIT * 2 + FIRMS_AMBIENT_COHORT_LIMIT
      + vesselOverlayCohortLimit(1600, 900) + 1 + CCTV_AMBIENT_CARD_MAX + 1
      + EARTHQUAKE_OVERLAY_COHORT_LIMIT + 3,
    maxBytesPerFrame: 132_000,
    maxBytesPerCandidatePerFrame: 225,
    saturated: true,
    ambientCardCapacity: AMBIENT_CARD_COLLISION_CAPACITY,
  },
  {
    name: 'with final Phase 5 sources and bounded rocket-mission markers live',
    profile: 'phase5-rockets',
    entries: LOCAL_OVERLAY_COHORT_LIMIT * 2 + FIRMS_AMBIENT_COHORT_LIMIT
      + vesselOverlayCohortLimit(1600, 900) + 1 + CCTV_AMBIENT_CARD_MAX + 1
      + EARTHQUAKE_OVERLAY_COHORT_LIMIT + 3
      + ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT,
    candidates: LOCAL_OVERLAY_COHORT_LIMIT * 2 + FIRMS_AMBIENT_COHORT_LIMIT
      + vesselOverlayCohortLimit(1600, 900) + 1 + CCTV_AMBIENT_CARD_MAX + 1
      + EARTHQUAKE_OVERLAY_COHORT_LIMIT + 3
      + ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT,
    // 142,000 deliberately carries ~6% headroom (vs the ~3.3% the previous
    // aggregate row ran at): a chosen margin correction, not drift.
    maxBytesPerFrame: 142_000,
    maxBytesPerCandidatePerFrame: 225,
    saturated: true,
    ambientCardCapacity: AMBIENT_CARD_COLLISION_CAPACITY,
  },
  {
    // Recalibrated 2026-08-18 when the migrated submarine-cable cohort joined
    // the aggregate (the row is "every shared-host source", so cable labels
    // must coexist with Radio/earthquake/mission quotas here, not only in
    // their isolated row; the probe shows cables winning painted slots in the
    // saturated ambient-label domain). Node 24.19 measures 164,711 B/frame
    // median (190.6 B/candidate) across two identical runs with cables folded
    // in; 182,000 keeps the row's >10% headroom convention and the
    // image-inclusive 225 ceiling stands with ~15% headroom.
    name: 'with every shared-host source and bounded Radio text live',
    profile: 'all-live-radio',
    entries: LOCAL_OVERLAY_COHORT_LIMIT * 2 + FIRMS_AMBIENT_COHORT_LIMIT
      + vesselOverlayCohortLimit(1600, 900) + 1 + CCTV_AMBIENT_CARD_MAX + 1
      + EARTHQUAKE_OVERLAY_COHORT_LIMIT + 3
      + ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT + RADIO_OVERLAY_COHORT_LIMIT + 1
      + CABLE_REFERENCE_LABEL_WINNER_CAP,
    candidates: LOCAL_OVERLAY_COHORT_LIMIT * 2 + FIRMS_AMBIENT_COHORT_LIMIT
      + vesselOverlayCohortLimit(1600, 900) + 1 + CCTV_AMBIENT_CARD_MAX + 1
      + EARTHQUAKE_OVERLAY_COHORT_LIMIT + 3
      + ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT + RADIO_OVERLAY_COHORT_LIMIT + 1
      + CABLE_REFERENCE_LABEL_WINNER_CAP,
    maxBytesPerFrame: 182_000,
    maxBytesPerCandidatePerFrame: 225,
    saturated: true,
    ambientCardCapacity: AMBIENT_CARD_COLLISION_CAPACITY,
  },
  {
    // 2026-08-18 cable-label migration: the former native exception now
    // publishes a bounded 160-winner ambient-label cohort (collision capacity
    // 96, so the row saturates). Isolated row like rocket-missions, so a
    // cables-only regression stays attributable; the cohort is also folded
    // into the recalibrated all-live aggregate below for interaction
    // coverage. Measured median 17,015 B/frame (106.3 B/candidate)
    // on Node 24.19; 19,000 carries ~11.7% headroom and the shared 154
    // ceiling applies unchanged.
    name: 'with the bounded submarine-cable reference cohort',
    profile: 'submarine-cables',
    entries: CABLE_REFERENCE_LABEL_WINNER_CAP,
    candidates: CABLE_REFERENCE_LABEL_WINNER_CAP,
    maxBytesPerFrame: 19_000,
    saturated: true,
  },
  {
    name: 'with the Dense detection lane active over 5,000 observations',
    profile: 'phase6-detection',
    entries: 5_000,
    candidates: 5_000,
    maxBytesPerFrame: 700_000,
    detectionLabelBudget: 56,
    saturated: false,
  },
];

/** Scale-invariant ceiling shared by every production-shape workload. */
const MAX_BYTES_PER_CANDIDATE_PER_FRAME = 154;

const WORKER_PATH = fileURLToPath(new URL('./worldOverlayAllocation.worker.mjs', import.meta.url));

const CALIBRATED_ALLOCATION_RUNTIME = isCalibratedAllocationRuntime();

function runAllocationProbe(entryCount, profile = 'generic') {
  // Compile hot functions synchronously so the gate measures the calibrated
  // top optimization tier even when the parent unit suite is CPU-saturated.
  // With concurrent recompilation, the fixed frame warmup races TurboFan and
  // this worker nondeterministically measures a lower tier instead.
  const result = spawnSync(
    process.execPath,
    ['--expose-gc', '--no-concurrent-recompilation', WORKER_PATH],
    {
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      ...process.env,
      GEV_ALLOC_ENTRIES: String(entryCount),
      GEV_ALLOC_PROFILE: profile,
    },
    },
  );
  if (result.error) throw new Error(`probe failed to spawn: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`probe exited with ${result.status}: ${String(result.stderr).slice(0, 400)}`);
  }
  const line = String(result.stdout).trim().split('\n').filter(Boolean).at(-1);
  if (!line) throw new Error('probe produced no output');
  let payload;
  try {
    payload = JSON.parse(line);
  } catch (error) {
    throw new Error(`probe output was not JSON: ${error.message}`);
  }
  if (payload.ok !== true) throw new Error(`probe unavailable: ${payload.reason}`);
  return payload;
}

for (const workload of WORKLOADS) {
  test(`steady moving-source frames stay in budget ${workload.name}`, (t) => {
    if (!CALIBRATED_ALLOCATION_RUNTIME) {
      return t.skip(`allocation budgets are calibrated for Node 24; running ${process.versions.node}`);
    }
    const payload = runAllocationProbe(workload.entries, workload.profile);

    // Workload guards: a probe that stopped painting, stopped re-solving, or
    // quietly shrank its cohort would report a flattering number for the wrong
    // reason. Painted count is deliberately NOT pinned to the entry count.
    assert.equal(payload.entryCount, workload.entries);
    assert.equal(payload.candidateCount, workload.candidates, 'bounded cohorts changed unexpectedly');
    assert.equal(payload.profile, workload.profile || 'generic');
    if (workload.ambientCardCapacity != null) {
      assert.equal(payload.ambientCardCapacity, workload.ambientCardCapacity);
    }
    if (workload.detectionLabelBudget != null) {
      assert.equal(payload.detectionCollectiveLabelBudget, workload.detectionLabelBudget);
      assert.equal(payload.detectionSelectedCount, workload.detectionLabelBudget);
    }
    assert.ok(payload.paintedCount > 0, 'probe painted nothing');
    assert.ok(payload.solveCount > 0, 'probe never exercised an arbiter solve');
    assert.ok(payload.measuredFrames >= 400, 'probe measured too few frames');
    if (workload.saturated) {
      assert.ok(
        payload.paintedCount < payload.candidateCount,
        'workload was supposed to exceed the domain collision capacity',
      );
    }

    const report = `${payload.candidateCount} candidates / ${payload.paintedCount} painted`
      + `, median ${payload.medianBytesPerFrame.toFixed(0)} B/frame`
      + ` (max ${payload.maxBytesPerFrame.toFixed(0)})`
      + `, median ${payload.medianBytesPerCandidatePerFrame.toFixed(1)} B/candidate/frame`
      + ` over ${payload.measuredFrames} frames and ${payload.solveCount} solves`
      + `; chunks: ${payload.chunkBytesPerFrame.map((value) => value.toFixed(0)).join(', ')}`;

    assert.ok(
      payload.medianBytesPerFrame <= workload.maxBytesPerFrame,
      `world-overlay steady frame exceeded ${workload.maxBytesPerFrame} B/frame: ${report}`,
    );
    assert.ok(
      payload.medianBytesPerCandidatePerFrame
        <= (workload.maxBytesPerCandidatePerFrame ?? MAX_BYTES_PER_CANDIDATE_PER_FRAME),
      `world-overlay steady frame exceeded ${workload.maxBytesPerCandidatePerFrame
        ?? MAX_BYTES_PER_CANDIDATE_PER_FRAME} B/candidate: ${report}`,
    );
  });
}
