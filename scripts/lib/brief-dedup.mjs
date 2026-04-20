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
 *   invalidModeRaw: string | null,
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
    // Unrecognised value — default to embed (the normal prod path)
    // but surface so a DIGEST_DEDUP_MODE=embbed typo is obvious.
    mode = 'embed';
    invalidModeRaw = modeRaw;
  }

  // DIGEST_DEDUP_CLUSTERING = 'single' (default) | 'complete'.
  // Single-link chains wire variants that share a strong
  // intermediate headline (calibrated F1 0.73 vs complete-link 0.53
  // on real brief output). Flip to 'complete' for instant kill
  // switch if single-link ever over-merges in production.
  const clusteringRaw = (env.DIGEST_DEDUP_CLUSTERING ?? '').toLowerCase();
  const clustering =
    clusteringRaw === 'complete' ? 'complete'
    : clusteringRaw === 'single' || clusteringRaw === '' ? 'single'
    : 'single';

  const cosineRaw = Number.parseFloat(env.DIGEST_DEDUP_COSINE_THRESHOLD ?? '');
  const cosineThreshold =
    Number.isFinite(cosineRaw) && cosineRaw > 0 && cosineRaw <= 1 ? cosineRaw : 0.60;

  const wallClockRaw = Number.parseInt(env.DIGEST_DEDUP_WALL_CLOCK_MS ?? '', 10);
  const wallClockMs =
    Number.isInteger(wallClockRaw) && wallClockRaw > 0 ? wallClockRaw : 45_000;

  return {
    mode,
    clustering,
    entityVetoEnabled: env.DIGEST_DEDUP_ENTITY_VETO_ENABLED !== '0',
    cosineThreshold,
    wallClockMs,
    invalidModeRaw,
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
 * @param {(line: string) => void} [deps.log]
 * @param {(line: string) => void} [deps.warn]
 */
export async function deduplicateStories(stories, deps = {}) {
  const cfg = readOrchestratorConfig(deps.env ?? process.env);
  const jaccard = deps.jaccard ?? deduplicateStoriesJaccard;
  const log = deps.log ?? ((line) => console.log(line));
  const warn = deps.warn ?? ((line) => console.warn(line));

  if (cfg.invalidModeRaw !== null) {
    warn(
      `[digest] dedup unrecognised DIGEST_DEDUP_MODE=${cfg.invalidModeRaw} — ` +
        'defaulting to embed. Valid values: embed | jaccard.',
    );
  }

  if (!Array.isArray(stories) || stories.length === 0) return [];

  // Kill switch: Railway operator sets MODE=jaccard to instantly
  // revert to the legacy deduper without a redeploy.
  if (cfg.mode === 'jaccard') {
    return jaccard(stories);
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
    const embedOutput = embedClusters.map((cluster) =>
      materializeCluster(cluster.map((i) => items[i].story)),
    );

    log(
      `[digest] dedup mode=embed clustering=${cfg.clustering} stories=${items.length} clusters=${embedClusters.length} ` +
        `veto_fires=${clusterResult.vetoFires} ms=${nowImpl() - started} ` +
        `threshold=${cfg.cosineThreshold} fallback=false`,
    );
    return embedOutput;
  } catch (err) {
    const reason =
      err instanceof Error && typeof err.name === 'string' && err.name !== 'Error'
        ? err.name
        : 'other';
    const msg = err instanceof Error ? err.message : String(err);
    warn(
      `[digest] dedup embed path failed, falling back to Jaccard reason=${reason} msg=${msg}`,
    );
    return jaccard(stories);
  }
}
