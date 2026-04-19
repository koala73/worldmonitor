/**
 * Embedding client for brief-dedup.
 *
 * Exports:
 *   - normalizeForEmbedding(title): the SINGLE function that produces
 *     both the embedded string and the cache-key input. No aliasing
 *     possible (plan's "normalization contract").
 *   - embedBatch(normalizedTitles, deps): batched, cached, all-or-
 *     nothing. Throws EmbeddingTimeoutError on wall-clock overrun and
 *     EmbeddingProviderError on any upstream failure. Never returns a
 *     partial result.
 *
 * Contract details:
 *   - Cache: brief:emb:v1:text-3-small-512:<sha256(normalized)>,
 *     14-day TTL, JSON array of 512 numbers.
 *   - Deterministic: same input → same output vectors (cache hits)
 *     or same OpenRouter call (cache misses).
 *   - `deps` is for tests — prod callers pass nothing and get the
 *     real fetch / Upstash / AbortSignal wired in.
 */

import { createHash } from 'node:crypto';

import {
  CACHE_KEY_PREFIX,
  CACHE_TTL_SECONDS,
  EMBED_DIMS,
  EMBED_MODEL,
  OPENROUTER_EMBEDDINGS_URL,
} from './brief-dedup-consts.mjs';
import { stripSourceSuffix } from './brief-dedup-jaccard.mjs';
import { defaultRedisPipeline } from './_upstash-pipeline.mjs';

export class EmbeddingProviderError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message);
    this.name = 'EmbeddingProviderError';
    if (status !== undefined) this.status = status;
    if (cause !== undefined) this.cause = cause;
  }
}

export class EmbeddingTimeoutError extends Error {
  constructor(message = 'Embedding wall-clock budget exceeded') {
    super(message);
    this.name = 'EmbeddingTimeoutError';
  }
}

/**
 * The ONE normalisation function. Cache-key input = embed-request
 * input. Any caller that embeds outside this function will drift.
 *
 *   1. Strip wire-service suffixes (" - Reuters", " | AP News", etc.)
 *      via the shared stripSourceSuffix so the outlet allow-list is
 *      single-sourced with the Jaccard fallback. Adding a new outlet
 *      updates both paths at once.
 *   2. Trim.
 *   3. Collapse internal whitespace.
 *   4. Lowercase.
 */
export function normalizeForEmbedding(title) {
  if (typeof title !== 'string') return '';
  return stripSourceSuffix(title).trim().replace(/\s+/g, ' ').toLowerCase();
}

export function cacheKeyFor(normalizedTitle) {
  const hash = createHash('sha256').update(normalizedTitle).digest('hex');
  return `${CACHE_KEY_PREFIX}:${hash}`;
}

// Default (production) deps wiring lives in ./_upstash-pipeline.mjs so
// the orchestrator and the embedding client share one implementation.

/**
 * Look up a set of cache keys via the redis pipeline and return a
 * Map of key → vector for the hits. Misses, corrupt cells, pipeline
 * failures are all treated as "not in cache" — the caller falls
 * through to the API.
 *
 * Kept as a helper so embedBatch's cognitive complexity stays
 * reviewable; there's no other caller.
 */
async function cacheGetBatched(uniqueKeys, pipelineImpl) {
  const hits = new Map();
  if (uniqueKeys.length === 0) return hits;
  const getResults = await pipelineImpl(uniqueKeys.map((k) => ['GET', k]));
  if (!Array.isArray(getResults)) return hits;
  for (let i = 0; i < uniqueKeys.length; i++) {
    const cell = getResults[i];
    const raw = cell && typeof cell === 'object' && 'result' in cell ? cell.result : null;
    if (typeof raw !== 'string') continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length === EMBED_DIMS) {
        hits.set(uniqueKeys[i], parsed);
      }
    } catch {
      // Corrupt cache cell: treat as miss. Don't error — next
      // successful API call will overwrite.
    }
  }
  return hits;
}

/**
 * Single batched OpenRouter /embeddings call for `missingTitles`.
 * Returns a number[N] where N = missingTitles.length. Throws
 * EmbeddingTimeoutError on abort/timeout, EmbeddingProviderError on
 * any other upstream failure. NEVER returns a partial result.
 */
async function callEmbeddingsApi({ fetchImpl, apiKey, missingTitles, timeoutMs }) {
  // Negative / zero remaining-budget means the deadline is already past.
  // Bail to the orchestrator's all-or-nothing fallback rather than open a
  // doomed HTTP connection that blows the wall-clock cap by the floor.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new EmbeddingTimeoutError();
  }
  let resp;
  try {
    resp = await fetchImpl(OPENROUTER_EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://worldmonitor.app',
        'X-Title': 'World Monitor',
        'User-Agent': 'worldmonitor-digest/1.0',
      },
      body: JSON.stringify({
        model: EMBED_MODEL,
        input: missingTitles,
        dimensions: EMBED_DIMS,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new EmbeddingTimeoutError();
    }
    throw new EmbeddingProviderError(
      `embedBatch: fetch failed — ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (!resp.ok) {
    throw new EmbeddingProviderError(
      `embedBatch: OpenRouter returned HTTP ${resp.status}`,
      { status: resp.status },
    );
  }
  let body;
  try {
    body = await resp.json();
  } catch (err) {
    throw new EmbeddingProviderError(
      `embedBatch: response JSON parse failed — ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const data = Array.isArray(body?.data) ? body.data : null;
  if (!data || data.length !== missingTitles.length) {
    throw new EmbeddingProviderError(
      `embedBatch: expected ${missingTitles.length} embeddings, got ${data?.length ?? 'none'}`,
    );
  }
  // Honour entry.index if the provider re-orders; fall back to i.
  const out = new Array(missingTitles.length);
  for (let i = 0; i < data.length; i++) {
    const entry = data[i];
    const idx = typeof entry?.index === 'number' ? entry.index : i;
    const vector = entry?.embedding;
    if (!Array.isArray(vector) || vector.length !== EMBED_DIMS) {
      throw new EmbeddingProviderError(
        `embedBatch: embedding[${idx}] has unexpected length ${vector?.length ?? 'n/a'}`,
      );
    }
    out[idx] = vector;
  }
  return out;
}

/**
 * Embed a batch of already-normalised titles with cache look-through.
 *
 * @param {string[]} normalizedTitles  output of normalizeForEmbedding for each title
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetch]
 * @param {(commands: Array<unknown[]>) => Promise<Array<{result: unknown}> | null>} [deps.redisPipeline]
 * @param {() => number} [deps.now]
 * @param {number} [deps.wallClockMs]
 * @param {string} [deps._apiKey]  OPENROUTER_API_KEY override (tests only;
 *   prefixed to discourage accidental spread from user-controlled objects)
 * @returns {Promise<number[][]>}  one 512-dim vector per input, in order
 *
 * Throws EmbeddingTimeoutError on wall-clock overrun.
 * Throws EmbeddingProviderError on any upstream / parse failure.
 * NEVER returns a partial batch — the orchestrator relies on this to
 * collapse the entire run to Jaccard on any failure.
 */
export async function embedBatch(normalizedTitles, deps = {}) {
  if (!Array.isArray(normalizedTitles)) {
    throw new EmbeddingProviderError('embedBatch: normalizedTitles must be an array');
  }
  if (normalizedTitles.length === 0) return [];

  // Wrap rather than assign: bare `fetch` captures the current global
  // binding at lookup time, so later monkey-patches (instrumentation,
  // Edge-runtime shims) don't see the wrapper. See AGENTS.md's
  // "fetch.bind(globalThis) is BANNED" rule — same class of bug.
  const fetchImpl = deps.fetch ?? ((...args) => globalThis.fetch(...args));
  const pipelineImpl = deps.redisPipeline ?? defaultRedisPipeline;
  const nowImpl = deps.now ?? (() => Date.now());
  const wallClockMs = deps.wallClockMs ?? 45_000;
  const apiKey = deps._apiKey ?? process.env.OPENROUTER_API_KEY ?? '';

  if (!apiKey) {
    // Provider failure so the orchestrator falls back to Jaccard rather
    // than silently embedding with no auth.
    throw new EmbeddingProviderError('OPENROUTER_API_KEY not configured');
  }

  const deadline = nowImpl() + wallClockMs;

  // Deduped cache-key table. Same normalised title → same cache cell.
  const keyByIndex = normalizedTitles.map((t) => cacheKeyFor(t));
  const uniqueKeys = [...new Set(keyByIndex)];

  const vectorByKey = await cacheGetBatched(uniqueKeys, pipelineImpl);
  if (nowImpl() > deadline) throw new EmbeddingTimeoutError();

  // Build the miss list, preserving the first normalised title we
  // saw for each unique key.
  const missingKeys = uniqueKeys.filter((k) => !vectorByKey.has(k));
  if (missingKeys.length > 0) {
    const missingTitleByKey = new Map();
    for (let i = 0; i < normalizedTitles.length; i++) {
      if (!vectorByKey.has(keyByIndex[i]) && !missingTitleByKey.has(keyByIndex[i])) {
        missingTitleByKey.set(keyByIndex[i], normalizedTitles[i]);
      }
    }
    const missingTitles = missingKeys.map((k) => missingTitleByKey.get(k) ?? '');
    const freshVectors = await callEmbeddingsApi({
      fetchImpl,
      apiKey,
      missingTitles,
      timeoutMs: deadline - nowImpl(),
    });
    const cacheWrites = [];
    for (let i = 0; i < freshVectors.length; i++) {
      const key = missingKeys[i];
      vectorByKey.set(key, freshVectors[i]);
      cacheWrites.push(['SET', key, JSON.stringify(freshVectors[i]), 'EX', String(CACHE_TTL_SECONDS)]);
    }
    // Cache writes are best-effort — a failure costs us a re-embed
    // on the next run, never a correctness bug.
    try {
      await pipelineImpl(cacheWrites);
    } catch {
      // swallow
    }
  }

  // Map back to input order; duplicated titles share a vector.
  const out = new Array(normalizedTitles.length);
  for (let i = 0; i < normalizedTitles.length; i++) {
    const v = vectorByKey.get(keyByIndex[i]);
    if (!v) {
      throw new EmbeddingProviderError(
        `embedBatch: missing vector for index ${i} after API call`,
      );
    }
    out[i] = v;
  }
  return out;
}

/**
 * Cosine similarity for two equal-length vectors. Returns a value
 * in [-1, 1]; 1 = identical direction.
 *
 * Exported so the clusterer and tests share one implementation.
 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
