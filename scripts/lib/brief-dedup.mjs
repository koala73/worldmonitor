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
  ACTIVE_CONFIG_KEY,
  ACTIVE_CONFIG_TTL_SECONDS,
  SHADOW_ARCHIVE_KEY_PREFIX,
  SHADOW_ARCHIVE_TTL_SECONDS,
} from './brief-dedup-consts.mjs';
import {
  deduplicateStoriesJaccard,
  materializeCluster,
  stripSourceSuffix,
} from './brief-dedup-jaccard.mjs';
import {
  completeLinkCluster,
  shouldVeto,
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
 *   mode: 'jaccard' | 'shadow' | 'embed',
 *   remoteEmbedEnabled: boolean,
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
  if (modeRaw === '' || modeRaw === 'jaccard') {
    mode = 'jaccard';
  } else if (modeRaw === 'embed' || modeRaw === 'shadow') {
    mode = modeRaw;
  } else {
    // Unrecognised value — fall back to jaccard but surface to the
    // operator so a DIGEST_DEDUP_MODE=embbed typo doesn't silently
    // stay on the legacy path for a 14-day shadow window.
    mode = 'jaccard';
    invalidModeRaw = modeRaw;
  }

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
    invalidModeRaw,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function titleHashHex(normalizedTitle) {
  return createHash('sha256').update(normalizedTitle).digest('hex');
}

/**
 * Enumerate pairs and check whether each system merged them. Returns
 * the subset of pairs where the two systems disagree.
 *
 * Works in hash-space so cluster representations from different
 * input orderings compare cleanly.
 *
 * @pre `allHashes` contains unique values. Upstream `buildDigest`
 * already dedupes by `story:track:v1:<hash>` so this holds in
 * production; if it ever stops holding, the hash→cluster index
 * will overwrite entries and the diff will be wrong.
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
 * Project a list of Jaccard reps (output of deduplicateStoriesJaccard)
 * into the hash-arrays-per-cluster shape diffClustersByHash expects.
 */
function jaccardRepsToClusterHashes(reps) {
  return reps.map((rep) => rep.mergedHashes ?? [rep.hash]);
}

/**
 * Publish the resolved orchestrator config to Upstash so the GitHub
 * Actions canary can read it instead of depending on parallel repo
 * variables. Fire-and-forget; if the SET fails, the canary sees a
 * stale/missing key and skips for that night — still strictly
 * better than diverging config across Railway and GH vars.
 */
async function publishActiveConfig(pipelineImpl, cfg, now) {
  const payload = JSON.stringify({
    mode: cfg.mode,
    remoteEmbedEnabled: cfg.remoteEmbedEnabled,
    entityVetoEnabled: cfg.entityVetoEnabled,
    cosineThreshold: cfg.cosineThreshold,
    wallClockMs: cfg.wallClockMs,
    writtenAt: now,
  });
  try {
    await pipelineImpl([['SET', ACTIVE_CONFIG_KEY, payload, 'EX', String(ACTIVE_CONFIG_TTL_SECONDS)]]);
  } catch {
    // Swallowing is intentional: a stale key just makes the canary
    // skip that night. Not a correctness issue.
  }
}

/**
 * Persist one shadow-mode batch. Returns an object describing the
 * write outcome so the caller can surface it in structured logs and
 * a Sentry warn. "Fail open" is the wrong semantics here: the Sample
 * B sampler reads the archive at labelling time, and a silently-
 * dropped batch turns the calibration window into a no-op without
 * anyone noticing.
 *
 * Result shape:
 *   { ok: true,  key }                       // confirmed OK from Upstash
 *   { ok: false, key, reason: <string> }     // auth/timeout/HTTP error,
 *                                            // malformed cell, or a per-
 *                                            // command error from the
 *                                            // Upstash pipeline
 */
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
  let result;
  try {
    result = await pipelineImpl([['SET', key, value, 'EX', String(SHADOW_ARCHIVE_TTL_SECONDS)]]);
  } catch (err) {
    return { ok: false, key, reason: err instanceof Error ? err.message : String(err) };
  }
  // defaultRedisPipeline returns null on missing creds / non-2xx /
  // network timeout. Treat that as a write failure rather than
  // pretending success.
  if (result === null) {
    return { ok: false, key, reason: 'pipeline_null_or_network_error' };
  }
  if (!Array.isArray(result) || result.length === 0) {
    return { ok: false, key, reason: 'pipeline_empty_response' };
  }
  const cell = result[0];
  if (cell && typeof cell === 'object' && 'error' in cell) {
    return { ok: false, key, reason: `upstash_error:${String(cell.error).slice(0, 120)}` };
  }
  // Upstash REST returns `{ result: "OK" }` on success. Anything else
  // (missing result field, unexpected value) gets treated as failure
  // — better a false-positive alarm than a silent drop.
  const okResult = cell && typeof cell === 'object' && 'result' in cell && cell.result === 'OK';
  if (!okResult) {
    return {
      ok: false,
      key,
      reason: `unexpected_result:${JSON.stringify(cell).slice(0, 120)}`,
    };
  }
  return { ok: true, key };
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
  const pipelineImpl = deps.redisPipeline ?? defaultRedisPipeline;
  const nowImpl = deps.now ?? (() => Date.now());

  if (cfg.invalidModeRaw !== null) {
    warn(
      `[digest] dedup unrecognised DIGEST_DEDUP_MODE=${cfg.invalidModeRaw} — ` +
        'falling back to jaccard. Valid values: jaccard | shadow | embed.',
    );
  }

  if (!Array.isArray(stories) || stories.length === 0) return [];

  // Publish the live config to Upstash so the nightly canary can
  // validate against the same classifier without requiring parallel
  // repo variables. Fire-and-forget; a failed write just makes the
  // next canary run skip. Runs regardless of mode so "prod is on
  // jaccard" is a readable signal, not an absence of signal.
  await publishActiveConfig(pipelineImpl, cfg, nowImpl());

  // Short-circuit: embedding path disabled entirely. This is the
  // hard kill switch — takes precedence over MODE.
  if (!cfg.remoteEmbedEnabled || cfg.mode === 'jaccard') {
    return jaccard(stories);
  }

  const embedImpl = deps.embedBatch ?? embedBatch;
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
    const clusterResult = completeLinkCluster(items, {
      cosineThreshold: cfg.cosineThreshold,
      vetoFn,
    });

    const embedClusters = clusterResult.clusters;
    const embedOutput = embedClusters.map((cluster) =>
      materializeCluster(cluster.map((i) => items[i].story)),
    );
    const elapsed = nowImpl() - started;

    if (cfg.mode === 'shadow') {
      // Shadow: run Jaccard ONCE for both the user-visible return
      // value AND the disagreement diff. Archive the batch for
      // Sample B drawing. Ship Jaccard output so user-visible
      // behaviour is unchanged until the Phase D flip.
      const jaccardReps = jaccard(stories);
      const jaccardClusterHashes = jaccardRepsToClusterHashes(jaccardReps);
      const embedClusterHashes = embedClusters.map((c) => c.map((i) => items[i].hash));
      const allHashes = stories.map((s) => s.hash);
      const disagreements = diffClustersByHash(
        embedClusterHashes,
        jaccardClusterHashes,
        allHashes,
      );
      const archiveResult = await writeShadowArchive({
        pipelineImpl,
        timestamp: started,
        items,
        embedClusters: embedClusterHashes,
        jaccardClusters: jaccardClusterHashes,
        disagreements,
      });
      // Silent archive failures are the #1 way a Phase C rollout turns
      // into a calibration-data no-op — surface every bad write so
      // Sentry catches the drift before labelling day.
      if (!archiveResult.ok) {
        warn(
          `[digest] dedup shadow archive write failed — ` +
            `reason=${archiveResult.reason} key=${archiveResult.key}`,
        );
      }
      log(
        `[digest] dedup mode=shadow stories=${items.length} embed_clusters=${embedClusterHashes.length} ` +
          `jaccard_clusters=${jaccardClusterHashes.length} disagreements=${disagreements.length} ` +
          `veto_fires=${clusterResult.vetoFires} ms=${elapsed} threshold=${cfg.cosineThreshold} ` +
          `archive_write=${archiveResult.ok ? 'ok' : 'failed'}`,
      );
      return jaccardReps;
    }

    log(
      `[digest] dedup mode=embed stories=${items.length} clusters=${embedClusters.length} ` +
        `veto_fires=${clusterResult.vetoFires} ms=${elapsed} threshold=${cfg.cosineThreshold} fallback=false`,
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
