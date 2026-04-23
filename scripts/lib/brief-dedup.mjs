/**
 * Dedup orchestrator — the single entry point the digest cron calls
 * to cluster its story list.
 *
 * Public: deduplicateStories(stories, deps?) returns the same shape
 * the earlier inline Jaccard produced:
 *   [{ ...representativeStoryFields, mentionCount, mergedHashes }, ...]
 *
 * Env knobs (read at call entry — Railway env flips take effect on
 * the next cron tick without a redeploy):
 *   DIGEST_DEDUP_MODE                 = 'embed' (default) | 'jaccard'
 *                                       (jaccard = instant kill switch)
 *   DIGEST_DEDUP_ENTITY_VETO_ENABLED  = '0' to bypass the actor/
 *                                       location veto; default on
 *   DIGEST_DEDUP_COSINE_THRESHOLD     = float in (0, 1], default 0.60
 *   DIGEST_DEDUP_WALL_CLOCK_MS        = int ms, default 45000
 *   DIGEST_DEDUP_TOPIC_GROUPING       = '0' disables secondary topic
 *                                       grouping pass; default on
 *   DIGEST_DEDUP_TOPIC_THRESHOLD      = float in (0, 1], default 0.45
 *                                       — looser secondary-pass cosine
 *
 * Anything non-{embed,jaccard} in MODE = jaccard with a loud warn so
 * a typo can't stay hidden.
 *
 * All-or-nothing fallback: if the embed path throws for any reason
 * (provider outage, timeout, missing API key, malformed response),
 * the orchestrator falls back to Jaccard for the entire batch and
 * emits a warn with `reason=<ErrorName>`. The cron NEVER fails
 * because embeddings flaked.
 */

import { createHash } from 'node:crypto';

import {
  deduplicateStoriesJaccard,
  materializeCluster,
  stripSourceSuffix,
} from './brief-dedup-jaccard.mjs';
import {
  completeLinkCluster,
  shouldVeto,
  singleLinkCluster,
} from './brief-dedup-embed.mjs';
import {
  embedBatch,
  normalizeForEmbedding,
} from './brief-embedding.mjs';
import { defaultRedisPipeline } from './_upstash-pipeline.mjs';

// ── Config resolution (env read at call entry) ─────────────────────────

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {{
 *   mode: 'jaccard' | 'embed',
 *   clustering: 'single' | 'complete',
 *   entityVetoEnabled: boolean,
 *   cosineThreshold: number,
 *   wallClockMs: number,
 *   topicGroupingEnabled: boolean,
 *   topicThreshold: number,
 *   invalidModeRaw: string | null,
 *   invalidClusteringRaw: string | null,
 * }}
 */
export function readOrchestratorConfig(env = process.env) {
  const modeRaw = (env.DIGEST_DEDUP_MODE ?? '').toLowerCase();
  let mode;
  let invalidModeRaw = null;
  if (modeRaw === '' || modeRaw === 'embed') {
    mode = 'embed';
  } else if (modeRaw === 'jaccard') {
    mode = 'jaccard';
  } else {
    // Unrecognised value — fall back to the SAFE path (Jaccard), not
    // the newer embed path. This matches the file-header contract: a
    // typo like `DIGEST_DEDUP_MODE=jacard` while an operator is trying
    // to set the kill switch during an embed outage must NOT silently
    // keep embed on. The invalidModeRaw warn surfaces the typo so it's
    // fixed, but the fail-closed default protects the cron in the
    // meantime.
    mode = 'jaccard';
    invalidModeRaw = modeRaw;
  }

  // DIGEST_DEDUP_CLUSTERING = 'single' (default when unset) | 'complete'.
  // Single-link chains wire variants that share a strong intermediate
  // headline (calibrated F1 0.73 vs complete-link 0.53 on real brief
  // output). 'complete' is the documented kill switch for when single-
  // link over-merges in production.
  //
  // Typo handling mirrors the MODE branch above: an unrecognised value
  // falls to 'complete' (the SAFE / conservative algorithm), not back
  // to 'single'. Rationale: if an operator is typing
  // `DIGEST_DEDUP_CLUSTERING=complet` during an over-merge incident,
  // silently sticking with the aggressive merger defeats the kill
  // switch. The invalidClusteringRaw warn surfaces the typo so it's
  // fixed, but the fail-closed default protects the cron meanwhile.
  const clusteringRaw = (env.DIGEST_DEDUP_CLUSTERING ?? '').toLowerCase();
  let clustering;
  let invalidClusteringRaw = null;
  if (clusteringRaw === '' || clusteringRaw === 'single') {
    clustering = 'single';
  } else if (clusteringRaw === 'complete') {
    clustering = 'complete';
  } else {
    clustering = 'complete';
    invalidClusteringRaw = clusteringRaw;
  }

  const cosineRaw = Number.parseFloat(env.DIGEST_DEDUP_COSINE_THRESHOLD ?? '');
  const cosineThreshold =
    Number.isFinite(cosineRaw) && cosineRaw > 0 && cosineRaw <= 1 ? cosineRaw : 0.60;

  const wallClockRaw = Number.parseInt(env.DIGEST_DEDUP_WALL_CLOCK_MS ?? '', 10);
  const wallClockMs =
    Number.isInteger(wallClockRaw) && wallClockRaw > 0 ? wallClockRaw : 45_000;

  // Secondary topic-grouping pass (default on). Kill switch: set to '0'.
  // Any non-'0' value (including '', 'yes', '1') is treated as enabled.
  const topicGroupingEnabled = env.DIGEST_DEDUP_TOPIC_GROUPING !== '0';

  // Looser cosine for the secondary pass (default 0.45). Invalid/out-of-range
  // values fall back to the default silently so a Railway typo can't disable
  // the feature by accident.
  const topicThresholdRaw = Number.parseFloat(env.DIGEST_DEDUP_TOPIC_THRESHOLD ?? '');
  const topicThreshold =
    Number.isFinite(topicThresholdRaw) && topicThresholdRaw > 0 && topicThresholdRaw <= 1
      ? topicThresholdRaw
      : 0.45;

  return {
    mode,
    clustering,
    entityVetoEnabled: env.DIGEST_DEDUP_ENTITY_VETO_ENABLED !== '0',
    cosineThreshold,
    wallClockMs,
    topicGroupingEnabled,
    topicThreshold,
    invalidModeRaw,
    invalidClusteringRaw,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function titleHashHex(normalizedTitle) {
  return createHash('sha256').update(normalizedTitle).digest('hex');
}

// ── Public entry point ─────────────────────────────────────────────────

/**
 * @param {Array<{hash:string, title:string, currentScore:number, mentionCount:number}>} stories
 * @param {object} [deps]
 * @param {Record<string,string|undefined>} [deps.env]
 * @param {typeof embedBatch} [deps.embedBatch]
 * @param {typeof deduplicateStoriesJaccard} [deps.jaccard]
 * @param {typeof defaultRedisPipeline} [deps.redisPipeline]
 * @param {() => number} [deps.now]
 * @param {(line: string) => void} [deps.warn]
 * @returns {Promise<{
 *   reps: Array<object>,
 *   embeddingByHash: Map<string, number[]>,
 *   logSummary: string,
 * }>}
 */
export async function deduplicateStories(stories, deps = {}) {
  const cfg = readOrchestratorConfig(deps.env ?? process.env);
  const jaccard = deps.jaccard ?? deduplicateStoriesJaccard;
  const warn = deps.warn ?? ((line) => console.warn(line));

  if (cfg.invalidModeRaw !== null) {
    warn(
      `[digest] dedup unrecognised DIGEST_DEDUP_MODE=${cfg.invalidModeRaw} — ` +
        'falling back to jaccard (safe rollback path). Valid values: embed | jaccard.',
    );
  }
  if (cfg.invalidClusteringRaw !== null) {
    warn(
      `[digest] dedup unrecognised DIGEST_DEDUP_CLUSTERING=${cfg.invalidClusteringRaw} — ` +
        'falling back to complete-link (safe / conservative). Valid values: single | complete.',
    );
  }

  if (!Array.isArray(stories) || stories.length === 0) {
    return { reps: [], embeddingByHash: new Map(), logSummary: '' };
  }

  // Kill switch: Railway operator sets MODE=jaccard to instantly
  // revert to the legacy deduper without a redeploy.
  if (cfg.mode === 'jaccard') {
    return { reps: jaccard(stories), embeddingByHash: new Map(), logSummary: '' };
  }

  const embedImpl = deps.embedBatch ?? embedBatch;
  const pipelineImpl = deps.redisPipeline ?? defaultRedisPipeline;
  const nowImpl = deps.now ?? (() => Date.now());
  const started = nowImpl();

  try {
    // Normalize + deterministic pre-sort so greedy first-fit is
    // permutation-invariant (property-tested in the embed test file).
    const prepared = stories.map((story, originalIndex) => {
      const normalizedTitle = normalizeForEmbedding(story.title);
      // `title` here is used as the veto input — must be case-
      // preserving (extractEntities looks at capitalised tokens)
      // but MUST NOT carry wire-source suffixes (" - Reuters" etc.)
      // that would otherwise leak into the actor set and fire the
      // veto on two copies of the same event from different outlets.
      const vetoTitle = stripSourceSuffix(story.title);
      return {
        story,
        originalIndex,
        hash: story.hash,
        title: vetoTitle,
        normalizedTitle,
        titleHashHex: titleHashHex(normalizedTitle),
        currentScore: Number(story.currentScore ?? 0),
        mentionCount: Number(story.mentionCount ?? 1),
      };
    });
    prepared.sort(
      (a, b) =>
        b.currentScore - a.currentScore ||
        (a.titleHashHex < b.titleHashHex ? -1 : a.titleHashHex > b.titleHashHex ? 1 : 0),
    );

    const embeddings = await embedImpl(
      prepared.map((p) => p.normalizedTitle),
      {
        redisPipeline: pipelineImpl,
        wallClockMs: cfg.wallClockMs,
        now: nowImpl,
      },
    );
    if (!Array.isArray(embeddings) || embeddings.length !== prepared.length) {
      throw new Error('embedBatch returned unexpected result');
    }
    const items = prepared.map((p, i) => ({ ...p, embedding: embeddings[i] }));

    const vetoFn = cfg.entityVetoEnabled
      ? (a, b) => shouldVeto(a.title, b.title)
      : null;
    const clusterFn = cfg.clustering === 'complete' ? completeLinkCluster : singleLinkCluster;
    const clusterResult = clusterFn(items, {
      cosineThreshold: cfg.cosineThreshold,
      vetoFn,
    });

    const embedClusters = clusterResult.clusters;
    const embeddingByHash = new Map();
    const embedOutput = [];
    for (const cluster of embedClusters) {
      const rep = materializeCluster(cluster.map((i) => items[i].story));
      embedOutput.push(rep);
      if (cfg.topicGroupingEnabled) {
        // Find the item inside this cluster whose story wins materialize
        // (materializeCluster sort key: currentScore DESC, mentionCount DESC
        // — ties broken by input order). The winning story's hash matches
        // rep.hash; its embedding is the topic-grouping vector for rep.
        const winningIdx = cluster.find((i) => items[i].story.hash === rep.hash);
        if (winningIdx !== undefined) {
          embeddingByHash.set(rep.hash, items[winningIdx].embedding);
        } else {
          // Defensive: shouldn't fire — materializeCluster always picks a
          // hash that's in the cluster. Warn so a future refactor that
          // synthesises a new rep doesn't silently skip the sidecar
          // (would cause topic grouping to fall through to primary order).
          warn(`[digest] dedup sidecar: materialized rep ${rep.hash} not found in its cluster — topic grouping will skip this rep`);
        }
      }
    }

    const logSummary =
      `[digest] dedup mode=embed clustering=${cfg.clustering} stories=${items.length} clusters=${embedClusters.length} ` +
      `veto_fires=${clusterResult.vetoFires} ms=${nowImpl() - started} ` +
      `threshold=${cfg.cosineThreshold} fallback=false`;
    return { reps: embedOutput, embeddingByHash, logSummary };
  } catch (err) {
    const reason =
      err instanceof Error && typeof err.name === 'string' && err.name !== 'Error'
        ? err.name
        : 'other';
    const msg = err instanceof Error ? err.message : String(err);
    warn(
      `[digest] dedup embed path failed, falling back to Jaccard reason=${reason} msg=${msg}`,
    );
    return { reps: jaccard(stories), embeddingByHash: new Map(), logSummary: '' };
  }
}

// ── Secondary topic-grouping pass ───────────────────────────────────────

/**
 * Pure function. Re-orders already-sliced, already-deduped reps so related
 * stories form contiguous blocks, with the dominant thread (by topic size)
 * leading. Runs AFTER `deduplicateStories` + score-floor + top-N slice.
 *
 * No I/O, no logging, no Redis. Caller owns logging. Errors are RETURNED
 * not thrown — a throw would otherwise propagate into the caller's outer
 * try/catch around `deduplicateStories` and trigger the Jaccard fallback
 * for a topic-grouping bug, which is the wrong blast radius.
 *
 * Sort key: (topicSize DESC, topicMax DESC, repScore DESC, titleHashHex ASC)
 * — total, deterministic, stable across input permutations.
 *
 * @param {Array<{hash:string, title:string, currentScore:number}>} top
 * @param {{ topicGroupingEnabled: boolean, topicThreshold: number }} cfg
 * @param {Map<string, number[]>} embeddingByHash
 * @param {object} [deps]
 * @param {typeof singleLinkCluster} [deps.clusterFn] — injected for testing
 * @returns {{ reps: Array<object>, topicCount: number, error: Error | null }}
 */
export function groupTopicsPostDedup(top, cfg, embeddingByHash, deps = {}) {
  if (!cfg.topicGroupingEnabled || !Array.isArray(top) || top.length <= 1) {
    return { reps: Array.isArray(top) ? top : [], topicCount: Array.isArray(top) ? top.length : 0, error: null };
  }

  const clusterFn = deps.clusterFn ?? singleLinkCluster;

  try {
    const items = top.map((rep) => ({
      title: rep.title,
      embedding: embeddingByHash?.get(rep.hash),
    }));

    if (items.some((it) => !Array.isArray(it.embedding))) {
      return {
        reps: top,
        topicCount: top.length,
        error: new Error('topic grouping: missing embedding for at least one rep'),
      };
    }

    const { clusters } = clusterFn(items, {
      cosineThreshold: cfg.topicThreshold,
      // Topic level: do NOT re-apply the event-level entity veto. At this
      // cosine (~0.45) stories sharing the same broader narrative should
      // group even when their actor sets diverge (Biden+Xi vs Biden+Putin).
      vetoFn: null,
    });

    // Dense-fill with -1 sentinel so an incomplete clusterFn (a future
    // injection that doesn't cover every input index) surfaces as an
    // explicit error instead of silently poisoning the phase-1 aggregates
    // (topicSize[undefined] / topicMax[undefined] would degrade the sort).
    const topicOf = new Array(top.length).fill(-1);
    clusters.forEach((members, tIdx) => {
      for (const i of members) topicOf[i] = tIdx;
    });
    for (let i = 0; i < topicOf.length; i++) {
      if (topicOf[i] === -1) {
        throw new Error(`topic grouping: clusterFn missed index ${i}`);
      }
    }

    const hashOf = top.map((rep) =>
      titleHashHex(normalizeForEmbedding(rep.title ?? '')),
    );

    // Two-phase sort, NOT a single global key. A global key that ties
    // on (topicSize, topicMax) falls through to per-rep repScore, which
    // interleaves members of same-size-same-max topics (A90,B90,A80,B70
    // would sort as [A90,B90,A80,B70] — broken contiguity). Phase 1
    // orders the TOPICS; phase 2 orders members inside each topic.

    // Phase 1 prep: per-topic aggregates + a TOPIC-level tiebreak hash
    // (min member title hash) so cross-topic ties break by topic
    // identity, not by an individual rep's hash.
    const topicSize = new Array(clusters.length).fill(0);
    const topicMax = new Array(clusters.length).fill(-Infinity);
    const topicTieHash = new Array(clusters.length).fill(null);
    top.forEach((rep, i) => {
      const t = topicOf[i];
      topicSize[t] += 1;
      const s = Number(rep.currentScore ?? 0);
      if (s > topicMax[t]) topicMax[t] = s;
      if (topicTieHash[t] === null || hashOf[i] < topicTieHash[t]) {
        topicTieHash[t] = hashOf[i];
      }
    });

    // Members grouped by topic for phase-2 ordering.
    const membersOf = Array.from({ length: clusters.length }, () => []);
    for (let i = 0; i < top.length; i++) {
      membersOf[topicOf[i]].push(i);
    }

    // Phase 2: sort members within each topic by (repScore DESC,
    // titleHashHex ASC). Deterministic within a topic.
    for (const members of membersOf) {
      members.sort((a, b) => {
        const sA = Number(top[a].currentScore ?? 0);
        const sB = Number(top[b].currentScore ?? 0);
        if (sA !== sB) return sB - sA;
        return hashOf[a] < hashOf[b] ? -1 : hashOf[a] > hashOf[b] ? 1 : 0;
      });
    }

    // Phase 1 sort: order TOPICS by (topicSize DESC, topicMax DESC,
    // topicTieHash ASC). The topic-tie hash is a property of the topic
    // itself, so two topics with the same (size, max) order stably and
    // — critically — do not interleave their members.
    const topicOrder = [...Array(clusters.length).keys()].sort((a, b) => {
      if (topicSize[a] !== topicSize[b]) return topicSize[b] - topicSize[a];
      if (topicMax[a] !== topicMax[b]) return topicMax[b] - topicMax[a];
      return topicTieHash[a] < topicTieHash[b] ? -1 : topicTieHash[a] > topicTieHash[b] ? 1 : 0;
    });

    // Concatenate: for each topic in topicOrder, emit its members in
    // their intra-topic order.
    const order = [];
    for (const t of topicOrder) {
      for (const i of membersOf[t]) order.push(i);
    }

    return {
      reps: order.map((i) => top[i]),
      topicCount: clusters.length,
      error: null,
    };
  } catch (err) {
    return {
      reps: top,
      topicCount: top.length,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
