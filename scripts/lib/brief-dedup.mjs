/**
 * Dedup orchestrator — the single entry point the digest cron calls
 * to cluster its story list.
 *
 * Public: deduplicateStories(stories, deps?) returns the same shape
 * the earlier inline Jaccard produced:
 *   [{ ...representativeStoryFields, mentionCount, mergedHashes }, ...]
 *
 * Env knobs (read at call entry — env flips take effect on the next
 * cron tick without a redeploy):
 *   DIGEST_DEDUP_MODE                  = 'jaccard' | 'shadow' | 'embed'
 *   DIGEST_DEDUP_REMOTE_EMBED_ENABLED  = '0' to hard-kill network egress
 *   DIGEST_DEDUP_ENTITY_VETO_ENABLED   = '0' to bypass the actor/location veto
 *   DIGEST_DEDUP_COSINE_THRESHOLD      = float in (0, 1], default 0.60
 *   DIGEST_DEDUP_WALL_CLOCK_MS         = int ms, default 45000
 *
 * All-or-nothing fallback: any exception in the embed path collapses
 * the entire batch to the Jaccard implementation. The cron NEVER
 * fails because embeddings flaked.
 *
 * Shadow mode (MODE=shadow): runs BOTH dedupers, writes a per-run
 * archive to Upstash for Sample B drawing, and returns the Jaccard
 * output (user-visible behaviour unchanged until Phase D flip).
 */

import { createHash } from 'node:crypto';

import {
  CACHE_TTL_SECONDS,
  SHADOW_ARCHIVE_KEY_PREFIX,
  SHADOW_ARCHIVE_TTL_SECONDS,
} from './brief-dedup-consts.mjs';
import {
  deduplicateStoriesJaccard,
  stripSourceSuffix,
} from './brief-dedup-jaccard.mjs';
import {
  clusterWithEntityVeto,
  completeLinkCluster,
} from './brief-dedup-embed.mjs';
import {
  embedBatch,
  normalizeForEmbedding,
} from './brief-embedding.mjs';

// ── Config resolution (env read at call entry) ─────────────────────────

/**
 * @param {Record<string, string | undefined>} [env]
 */
export function readOrchestratorConfig(env = process.env) {
  const modeRaw = (env.DIGEST_DEDUP_MODE ?? 'jaccard').toLowerCase();
  const mode = modeRaw === 'embed' || modeRaw === 'shadow' ? modeRaw : 'jaccard';

  const cosineRaw = Number.parseFloat(env.DIGEST_DEDUP_COSINE_THRESHOLD ?? '');
  const cosineThreshold =
    Number.isFinite(cosineRaw) && cosineRaw > 0 && cosineRaw <= 1 ? cosineRaw : 0.60;

  const wallClockRaw = Number.parseInt(env.DIGEST_DEDUP_WALL_CLOCK_MS ?? '', 10);
  const wallClockMs =
    Number.isInteger(wallClockRaw) && wallClockRaw > 0 ? wallClockRaw : 45_000;

  return {
    mode,
    remoteEmbedEnabled: env.DIGEST_DEDUP_REMOTE_EMBED_ENABLED !== '0',
    entityVetoEnabled: env.DIGEST_DEDUP_ENTITY_VETO_ENABLED !== '0',
    cosineThreshold,
    wallClockMs,
  };
}

// ── Default (production) deps wiring ───────────────────────────────────

async function defaultRedisPipeline(commands) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token || commands.length === 0) return null;
  try {
    const resp = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'worldmonitor-digest/1.0',
      },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function titleHashHex(normalizedTitle) {
  return createHash('sha256').update(normalizedTitle).digest('hex');
}

/**
 * Apply the same representative-selection + mentionCount-sum +
 * mergedHashes contract the inline Jaccard path used. Takes a cluster
 * (list of story refs) and returns a single story object.
 */
function materializeCluster(members) {
  const sorted = [...members].sort(
    (a, b) => b.currentScore - a.currentScore || b.mentionCount - a.mentionCount,
  );
  const best = { ...sorted[0] };
  if (sorted.length > 1) {
    best.mentionCount = sorted.reduce((sum, s) => sum + s.mentionCount, 0);
  }
  best.mergedHashes = sorted.map((s) => s.hash);
  return best;
}

/**
 * Enumerate pairs and check whether each system merged them. Returns
 * the subset of pairs where the two systems disagree.
 *
 * Works in hash-space so cluster representations from different
 * input orderings compare cleanly.
 */
function diffClustersByHash(embedClusterHashes, jaccardClusterHashes, allHashes) {
  const embedIdxOf = new Map();
  const jaccardIdxOf = new Map();
  for (let cid = 0; cid < embedClusterHashes.length; cid++) {
    for (const h of embedClusterHashes[cid]) embedIdxOf.set(h, cid);
  }
  for (let cid = 0; cid < jaccardClusterHashes.length; cid++) {
    for (const h of jaccardClusterHashes[cid]) jaccardIdxOf.set(h, cid);
  }
  const disagreements = [];
  for (let i = 0; i < allHashes.length; i++) {
    for (let j = i + 1; j < allHashes.length; j++) {
      const ha = allHashes[i];
      const hb = allHashes[j];
      const em = embedIdxOf.get(ha) === embedIdxOf.get(hb);
      const jm = jaccardIdxOf.get(ha) === jaccardIdxOf.get(hb);
      if (em !== jm) {
        disagreements.push({ a: ha, b: hb, embedMerged: em, jaccardMerged: jm });
      }
    }
  }
  return disagreements;
}

/**
 * Run Jaccard on the given stories and return cluster membership as
 * arrays of story hashes (not indices). Shape matches the embed
 * path's hash-array projection so diffClustersByHash compares cleanly.
 */
function jaccardClusterHashesFor(stories) {
  return deduplicateStoriesJaccard(stories).map((rep) => rep.mergedHashes ?? [rep.hash]);
}

async function writeShadowArchive({
  pipelineImpl,
  timestamp,
  items,
  embedClusters,
  jaccardClusters,
  disagreements,
}) {
  const storyIds = items.map((it) => it.hash);
  const contentHash = createHash('sha256').update(storyIds.join(',')).digest('hex').slice(0, 8);
  const iso = new Date(timestamp).toISOString();
  const key = `${SHADOW_ARCHIVE_KEY_PREFIX}:${iso}:${contentHash}`;
  const value = JSON.stringify({
    timestamp,
    storyIds,
    normalizedTitles: items.map((it) => it.normalizedTitle),
    jaccardClusters,
    embeddingClusters: embedClusters,
    disagreementPairs: disagreements,
  });
  try {
    await pipelineImpl([['SET', key, value, 'EX', String(SHADOW_ARCHIVE_TTL_SECONDS)]]);
  } catch {
    // Archive write is best-effort; Sample B sampler only reads keys
    // that actually landed. A missed tick is not a correctness bug.
  }
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

  if (!Array.isArray(stories) || stories.length === 0) return [];

  // Short-circuit: embedding path disabled entirely. This is the
  // hard kill switch — takes precedence over MODE.
  if (!cfg.remoteEmbedEnabled || cfg.mode === 'jaccard') {
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

    const clusterResult = cfg.entityVetoEnabled
      ? clusterWithEntityVeto(items, { cosineThreshold: cfg.cosineThreshold })
      : completeLinkCluster(items, { cosineThreshold: cfg.cosineThreshold });

    const embedClusters = clusterResult.clusters;
    const embedOutput = embedClusters.map((cluster) =>
      materializeCluster(cluster.map((i) => items[i].story)),
    );
    const elapsed = nowImpl() - started;

    if (cfg.mode === 'shadow') {
      // Shadow: run BOTH systems, log disagreements, archive the
      // batch for Sample B drawing, and ship Jaccard output so
      // user-visible behaviour is unchanged until the Phase D flip.
      const embedClusterHashes = embedClusters.map((c) => c.map((i) => items[i].hash));
      const jaccardClusterHashes = jaccardClusterHashesFor(stories);
      const allHashes = stories.map((s) => s.hash);
      const disagreements = diffClustersByHash(
        embedClusterHashes,
        jaccardClusterHashes,
        allHashes,
      );
      await writeShadowArchive({
        pipelineImpl,
        timestamp: started,
        items,
        embedClusters: embedClusterHashes,
        jaccardClusters: jaccardClusterHashes,
        disagreements,
      });
      log(
        `[digest] dedup mode=shadow stories=${items.length} embed_clusters=${embedClusterHashes.length} ` +
          `jaccard_clusters=${jaccardClusterHashes.length} disagreements=${disagreements.length} ` +
          `veto_fires=${clusterResult.vetoFires} ms=${elapsed} threshold=${cfg.cosineThreshold}`,
      );
      return jaccard(stories);
    }

    log(
      `[digest] dedup mode=embed stories=${items.length} clusters=${embedClusters.length} ` +
        `veto_fires=${clusterResult.vetoFires} ms=${elapsed} threshold=${cfg.cosineThreshold} fallback=false`,
    );
    return embedOutput;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`[digest] dedup embed path failed, falling back to Jaccard: ${msg}`);
    return jaccard(stories);
  }
}

// Re-export helpers so the call site doesn't have to import from
// multiple lib files for the common cases.
export { deduplicateStoriesJaccard } from './brief-dedup-jaccard.mjs';
export { normalizeForEmbedding } from './brief-embedding.mjs';

// Re-export the default TTL in case downstream wants it (avoid
// importing brief-dedup-consts in a dozen places).
export { CACHE_TTL_SECONDS };
