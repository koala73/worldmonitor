/**
 * Replayable per-story input log for brief-dedup calibration.
 *
 * Problem this solves: we can't validate recall-lift options that shift
 * the embedding score distribution (title+slug, LLM-canonicalise, 3-large
 * model upgrade, etc.) from a baseline-band pair log alone. We need the
 * per-story inputs for every tick so offline replays can re-embed with
 * alternative configs and re-score the full pair matrix.
 *
 * See docs/brainstorms/2026-04-23-001-brief-dedup-recall-gap.md §5 Phase 1.
 *
 * Contract:
 *   - Opt-in via DIGEST_DEDUP_REPLAY_LOG=1 (default OFF — zero behaviour
 *     change on merge).
 *   - Best-effort: ALL failures are swallowed + warned. Replay-log write
 *     errors MUST NEVER affect digest delivery.
 *   - Append-only list in Upstash: one JSON record per story, keyed by
 *     rule + date so operators can range-query a day's traffic.
 *   - 30-day TTL (see §5 Phase 1 retention rationale: covers labelling
 *     cadence + cross-candidate comparison window; cache TTL is not the
 *     right anchor — replays that change embed config pay a fresh embed
 *     regardless of cache).
 */

import { cacheKeyFor, normalizeForEmbedding } from './brief-embedding.mjs';
import { defaultRedisPipeline } from './_upstash-pipeline.mjs';

const KEY_PREFIX = 'digest:replay-log:v1';
const TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * Env-read at call time so Railway can flip the flag without a redeploy.
 * Anything other than literal '1' (including unset, '0', 'yes', 'true',
 * mis-cased 'True') is treated as OFF — fail-closed so a typo can't
 * silently turn the log on in prod. '1' is the single intentional value.
 *
 * @param {Record<string,string|undefined>} [env]
 */
export function replayLogEnabled(env = process.env) {
  return env.DIGEST_DEDUP_REPLAY_LOG === '1';
}

/**
 * Build the Upstash list key for a given tick.
 *
 * Format: digest:replay-log:v1:{ruleId}:{YYYY-MM-DD}
 *
 * Scoped per-rule so operators can range-query a single rule's day
 * without scanning traffic from other digest variants. Date suffix
 * (UTC) caps list length to one day's cron ticks — prevents unbounded
 * growth of a single key over the 30-day retention window.
 *
 * Safe-characters gate on ruleId: strip anything not alnum/underscore/
 * hyphen so an exotic rule id can't escape the key namespace.
 */
export function buildReplayLogKey(ruleId, tsMs) {
  // Allow ':' so `variant:lang:sensitivity` composite ruleIds stay
  // readable as Redis key segments. Strip anything else to '_'; then
  // if the whole string collapsed to nothing meaningful — all '_',
  // ':', '-', or empty — use 'unknown' so the key namespace stays
  // consistent. Stripping ':' / '-' in the emptiness check prevents
  // pathological inputs like ':::' producing keys like
  // `digest:replay-log:v1::::2026-04-23` that confuse Redis namespace
  // tooling (SCAN / KEYS / redis-cli tab completion).
  const raw = String(ruleId ?? '').replace(/[^A-Za-z0-9:_-]/g, '_');
  const safeRuleId = raw.replace(/[_:-]/g, '') === '' ? 'unknown' : raw;
  const iso = new Date(tsMs).toISOString();
  const dateKey = iso.slice(0, 10); // YYYY-MM-DD
  return `${KEY_PREFIX}:${safeRuleId}:${dateKey}`;
}

/**
 * Build one JSON record per story in the dedup input.
 *
 * `clusterId` is derived from `reps[].mergedHashes` — the authoritative
 * cluster-membership contract that materializeCluster already provides
 * (brief-dedup-jaccard.mjs:75-85). No change to the orchestrator needed.
 *
 * `embeddingCacheKey` is computed from normalizeForEmbedding(title). It
 * only helps replays that keep the SAME embedding config (model, dims,
 * input transform) — replays that change any of those pay fresh embed
 * calls regardless. Still worth recording: it's ~60 bytes and makes
 * same-config replays cheap.
 *
 * @param {Array<object>} stories — the input passed to deduplicateStories
 * @param {Array<object>} reps — the reps returned by deduplicateStories
 * @param {Map<string, number[]>} embeddingByHash — sidecar from the embed path
 * @param {object} cfg — the full config object from readOrchestratorConfig
 * @param {object} tickContext
 * @param {string} tickContext.briefTickId
 * @param {string} tickContext.ruleId
 * @param {number} tickContext.tsMs
 * @returns {Array<object>}
 */
export function buildReplayRecords(stories, reps, embeddingByHash, cfg, tickContext) {
  // Derive hash → clusterId from rep membership. A rep's mergedHashes
  // lists every hash in its cluster including the rep's own; iterate
  // reps in output order and use the index as clusterId.
  const clusterByHash = new Map();
  if (Array.isArray(reps)) {
    reps.forEach((rep, clusterId) => {
      const hashes = Array.isArray(rep?.mergedHashes) ? rep.mergedHashes : [rep?.hash];
      for (const h of hashes) {
        if (typeof h === 'string' && !clusterByHash.has(h)) {
          clusterByHash.set(h, clusterId);
        }
      }
    });
  }

  // `repHashes` is a Set of the winning story's hash per cluster. A
  // story is the rep iff its hash === the rep.hash at its clusterId.
  const repHashes = new Set();
  if (Array.isArray(reps)) {
    for (const rep of reps) {
      if (typeof rep?.hash === 'string') repHashes.add(rep.hash);
    }
  }

  // Codex PR #3617 P1 — Sprint 1 / U6 cluster identity contract.
  //
  // Map storyHash → rep.hash so every record can carry the canonical
  // stable cluster identity (the rep's own hash, which equals
  // mergedHashes[0] by U3's contract from Sprint 1). The pre-fix
  // writer only emitted a per-tick numeric clusterId and the rep's
  // mergedHashes was unreachable from non-rep records; U6's harness
  // had to guess at cluster identity by re-deriving from individual
  // storyHashes, splitting clusters whenever a non-rep story got
  // sampled.
  //
  // Now: every record carries `repHash` (stable across ticks). U6
  // collapses by repHash to get one timeline per (ruleId, cluster)
  // regardless of which member story happened to be in the dedup
  // input that tick.
  //
  // We also retain a separate Map of rep.hash → mergedHashes so the
  // record builder can stamp mergedHashes ONLY onto rep records (the
  // mergedHashes set lives on the rep object, not on individual input
  // stories — readers asking "which storyHashes are in this cluster?"
  // need to consult the rep, not the member).
  const repHashByStoryHash = new Map();
  const mergedHashesByRepHash = new Map();
  // Codex PR #3617 round-3 P1 — sources live on REP objects (post
  // pre-hydration in seed-digest-notifications), NOT on the original
  // pre-dedup `stories` array. materializeCluster() in brief-dedup-jaccard
  // copies the rep into a new object, so mutations to dedupedAll[i].sources
  // never reach the input `stories[i]` references the writer iterates
  // below. Build a sourcesByRepHash Map here so EVERY record (rep AND
  // non-rep cluster member) gets the rep's hydrated source set —
  // non-reps share the rep's source identity by definition (the rep
  // is the cluster's canonical view).
  const sourcesByRepHash = new Map();
  if (Array.isArray(reps)) {
    for (const rep of reps) {
      const hashes = Array.isArray(rep?.mergedHashes) ? rep.mergedHashes : [rep?.hash];
      for (const h of hashes) {
        if (typeof h === 'string' && typeof rep?.hash === 'string' && !repHashByStoryHash.has(h)) {
          repHashByStoryHash.set(h, rep.hash);
        }
      }
      if (typeof rep?.hash === 'string' && Array.isArray(rep?.mergedHashes)) {
        mergedHashesByRepHash.set(rep.hash, rep.mergedHashes);
      }
      if (typeof rep?.hash === 'string' && Array.isArray(rep?.sources)) {
        sourcesByRepHash.set(rep.hash, rep.sources);
      }
    }
  }

  const tickConfig = {
    mode: cfg?.mode ?? null,
    clustering: cfg?.clustering ?? null,
    cosineThreshold: cfg?.cosineThreshold ?? null,
    // topicGroupingEnabled gates the post-dedup topic ordering pass in
    // seed-digest-notifications. Omitting it makes topic-grouping-off
    // ticks indistinguishable from default ticks at replay time, so
    // downstream replays can't reconstruct output behaviour for runs
    // with DIGEST_DEDUP_TOPIC_GROUPING=0. Serialise explicitly.
    topicGroupingEnabled: cfg?.topicGroupingEnabled ?? null,
    topicThreshold: cfg?.topicThreshold ?? null,
    entityVetoEnabled: cfg?.entityVetoEnabled ?? null,
  };

  const records = [];
  stories.forEach((story, originalIndex) => {
    const rawTitle = typeof story?.title === 'string' ? story.title : '';
    const normalizedTitle = normalizeForEmbedding(rawTitle);
    const cacheKey = rawTitle ? cacheKeyFor(normalizedTitle) : null;
    // hasEmbedding is a diagnostic: if the embed path produced a vector
    // for this rep, the sidecar has it. Useful in replay to tell apart
    // "embed path completed" from "embed path fell back to Jaccard".
    const hasEmbedding =
      embeddingByHash instanceof Map && embeddingByHash.has(story?.hash);
    // Codex PR #3617 P1 — Sprint 1 / U6 fields. headline + sourceUrl
    // are the canonical names U5's classifier expects (matches the
    // BriefStory schema and the digest-cooldown-decision input shape).
    // We keep `title` and `link` as legacy aliases for any older
    // consumer that pinned to the v1 shape.
    const link = typeof story?.link === 'string' ? story.link : null;
    const sourceUrl = link;
    const isRep = repHashes.has(story?.hash);
    // Codex PR #3617 round-3 P1 — read sources from the rep's hydrated
    // set (sourcesByRepHash) keyed by repHash, NOT from the input
    // story's `sources` field. The latter is empty at writeReplayLog
    // call time because materializeCluster returned copied rep objects
    // and pre-hydration mutates dedupedAll, not the input `stories`.
    const repHashForStory = repHashByStoryHash.has(story?.hash)
      ? repHashByStoryHash.get(story?.hash)
      : null;
    const repSources = repHashForStory && sourcesByRepHash.has(repHashForStory)
      ? sourcesByRepHash.get(repHashForStory)
      : null;
    records.push({
      v: 2, // Codex PR #3617 P1 — bump to v2 for repHash + headline + sourceUrl additions
      briefTickId: tickContext.briefTickId,
      ruleId: tickContext.ruleId,
      tsMs: tickContext.tsMs,
      storyHash: story?.hash ?? null,
      originalIndex,
      isRep,
      clusterId: clusterByHash.has(story?.hash)
        ? clusterByHash.get(story?.hash)
        : null,
      // Codex PR #3617 P1 — stable cluster identity (rep's own hash)
      // for every record, including non-rep cluster members. U6
      // collapses timelines by this field.
      repHash: repHashForStory,
      // Only reps carry the full mergedHashes set. Non-reps get null
      // (their cluster membership is preserved via repHash). The set
      // lives on the rep object (looked up via mergedHashesByRepHash);
      // input stories don't carry mergedHashes themselves.
      mergedHashes: isRep && typeof story?.hash === 'string' && mergedHashesByRepHash.has(story.hash)
        ? mergedHashesByRepHash.get(story.hash)
        : null,
      title: rawTitle,
      headline: rawTitle, // U5/U6 prefer this name; matches BriefStory.headline
      normalizedTitle,
      link,
      sourceUrl, // U5/U6 prefer this name; matches BriefStory.sourceUrl
      severity: story?.severity ?? null,
      currentScore: Number(story?.currentScore ?? 0),
      mentionCount: Number(story?.mentionCount ?? 1),
      phase: story?.phase ?? null,
      // Codex PR #3617 round-3 P1 — sources from the rep's hydrated
      // set, not the input story's (empty by construction at this point).
      // Non-rep records inherit the rep's set so cluster source-count
      // identity is uniform across all member records. Falls back to
      // the input story's sources when the rep map has no entry (e.g.
      // a synthetic test fixture passing pre-hydrated input stories
      // and bypass-rep-build paths) so existing tests don't break.
      sources: Array.isArray(repSources)
        ? repSources
        : (Array.isArray(story?.sources) ? story.sources : []),
      embeddingCacheKey: cacheKey,
      hasEmbedding,
      // Per-record shallow copy so an in-memory consumer (future
      // replay harness, test) that mutates one record's tickConfig
      // can't silently affect every other record via shared reference.
      // Serialisation goes through JSON.stringify in writeReplayLog so
      // storage is unaffected either way; this is purely an in-memory
      // footgun fix.
      tickConfig: { ...tickConfig },
    });
  });
  return records;
}

/**
 * Write the replay log for one dedup tick. Best-effort: every error is
 * caught and warned; the function NEVER throws.
 *
 * @param {object} args
 * @param {Array<object>} args.stories — input to deduplicateStories
 * @param {Array<object>} args.reps — output from deduplicateStories
 * @param {Map<string, number[]>} args.embeddingByHash — sidecar from deduplicateStories
 * @param {object} args.cfg — readOrchestratorConfig result
 * @param {object} args.tickContext
 * @param {string} args.tickContext.briefTickId
 * @param {string} args.tickContext.ruleId
 * @param {number} args.tickContext.tsMs
 * @param {object} [args.deps]
 * @param {Record<string,string|undefined>} [args.deps.env]
 * @param {typeof defaultRedisPipeline} [args.deps.redisPipeline]
 * @param {(line: string) => void} [args.deps.warn]
 * @returns {Promise<{ wrote: number, key: string | null, skipped: 'disabled' | 'empty' | null }>}
 */
export async function writeReplayLog(args) {
  const {
    stories,
    reps,
    embeddingByHash,
    cfg,
    tickContext,
    deps = {},
  } = args ?? {};
  const env = deps.env ?? process.env;
  const warn = deps.warn ?? ((line) => console.warn(line));

  if (!replayLogEnabled(env)) {
    return { wrote: 0, key: null, skipped: 'disabled' };
  }
  if (!Array.isArray(stories) || stories.length === 0) {
    return { wrote: 0, key: null, skipped: 'empty' };
  }

  try {
    const pipelineImpl = deps.redisPipeline ?? defaultRedisPipeline;
    const records = buildReplayRecords(
      stories,
      reps ?? [],
      embeddingByHash instanceof Map ? embeddingByHash : new Map(),
      cfg ?? {},
      tickContext ?? { briefTickId: 'unknown', ruleId: 'unknown', tsMs: Date.now() },
    );
    if (records.length === 0) {
      return { wrote: 0, key: null, skipped: 'empty' };
    }
    const key = buildReplayLogKey(tickContext?.ruleId, tickContext?.tsMs ?? Date.now());
    // Single RPUSH with variadic values (one per story) + EXPIRE. Keep
    // to two commands so Upstash's pipeline stays cheap even on large
    // ticks. Stringify each record individually so downstream readers
    // can consume with LRANGE + JSON.parse.
    const rpushCmd = ['RPUSH', key, ...records.map((r) => JSON.stringify(r))];
    const expireCmd = ['EXPIRE', key, String(TTL_SECONDS)];
    const result = await pipelineImpl([rpushCmd, expireCmd]);
    if (result == null) {
      warn(`[digest] replay-log: pipeline returned null (creds missing or upstream down) key=${key}`);
      return { wrote: 0, key, skipped: null };
    }
    return { wrote: records.length, key, skipped: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`[digest] replay-log: write failed — ${msg}`);
    return { wrote: 0, key: null, skipped: null };
  }
}
