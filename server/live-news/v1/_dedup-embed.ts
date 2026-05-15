/**
 * Embedding-based dedup — drop-in replacement for the LLM classifier
 * `classifyUnknownsAsync` in `_dedup.ts`. Same signature, same output
 * cache, same downstream behaviour. The dispatcher in `_dedup.ts`
 * picks between the two paths based on the `WM_DEDUP_MODE` env var.
 *
 * # Algorithm — online greedy clustering
 *
 * For each unknown item:
 *   1. Embed `title — first 300 chars of rawDescription` via Gemini
 *      text-embedding-004 (768-dim, free tier).
 *   2. Compare cosine to every OTHER item in the digest (both known
 *      anchors and other unknowns).
 *   3. If the best similarity exceeds `THRESHOLD` (0.7), this item
 *      joins that neighbour's cluster (canonical = neighbour's canonical).
 *   4. Otherwise it becomes its own canonical (a new cluster).
 *
 * Results are persisted to the SAME `live-news:dedup:v1:{titleHash}`
 * Redis key the LLM path uses, with the same 30-day TTL. That means
 * `loadCachedDedupMap` reads from a single store regardless of which
 * path wrote the entry — switching `WM_DEDUP_MODE` doesn't invalidate
 * prior decisions.
 *
 * # Embedding cache
 *
 * Per-item embedding cached at `live-news:embed:v1:{titleHash}` as
 * base64-encoded Float32. 24-hour TTL — matches the rolling clustering
 * window. Cuts API calls to roughly "new items per refresh" rather than
 * "all items every refresh".
 *
 * # Eligibility
 *
 * Unlike the LLM path, we DON'T require items to have `summary`/`country`
 * filled in. Title + raw RSS description is enough signal for clustering,
 * and that data exists immediately on first ingest. So the moment an RSS
 * item lands we can group it with its already-seen counterparts — no
 * 15-minute enrichment wait. Same-titled-but-no-summary items used to
 * sit in "unknown limbo"; now they cluster instantly.
 */

import { embedBatch, cosineSim, float32ToBase64, base64ToFloat32 } from '../../_shared/embeddings';
import { getCachedJsonBatch, setCachedJson } from '../../_shared/redis';
import type { LiveNewsItem } from './_normalize';

/** Per-user-spec — broader clusters bias. Tune up to 0.75-0.80 if we
 *  see over-merging in production. */
const THRESHOLD = 0.7;

/** Same key prefix as the LLM dedup writer in `_dedup.ts` so the two
 *  paths read/write the same cache. Don't rename without updating that
 *  file too. */
const DEDUP_CACHE_PREFIX = 'live-news:dedup:v1:';
const DEDUP_TTL_S = 3 * 24 * 60 * 60; // 3-day project-wide max retention

/** Embedding cache — separate namespace, shorter TTL because we only
 *  need the vector for items within the rolling clustering window. */
const EMBED_CACHE_PREFIX = 'live-news:embed:v1:';
const EMBED_TTL_S = 24 * 60 * 60;

/** Cap on the input length we send to the embedder. Stays well below
 *  the model's token limit and keeps payload size predictable. */
const MAX_INPUT_LEN = 400;

interface CachedDedupDecision {
  canonical: string;
}

function inputTextFor(item: LiveNewsItem): string {
  const title = item.title.trim();
  const desc = (item.rawDescription ?? '').trim().slice(0, 300);
  // Some RSS feeds embed inline HTML or "click here" CTAs in their
  // description. We strip HTML tags but trust the rest — the embedder
  // handles minor noise fine.
  const plain = desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const combined = plain ? `${title} — ${plain}` : title;
  return combined.slice(0, MAX_INPUT_LEN);
}

/**
 * Public entry-point matching the LLM dedup's signature so the
 * dispatcher in `_dedup.ts` can swap between them without touching
 * callers (live-news v1/v2 endpoints).
 *
 * Mutates `knownMap` in place — adds entries for every previously
 * unknown item.
 */
export async function classifyUnknownsViaEmbedAsync(
  allItems: LiveNewsItem[],
  knownMap: Map<string, string>,
): Promise<void> {
  const unknowns = allItems.filter((it) => !knownMap.has(it.titleHash));
  if (unknowns.length === 0) return;

  // ─── 1. Load any embeddings already cached ───
  const hashesNeedingEmbedding = new Set(unknowns.map((it) => it.titleHash));
  // Also include known items so we can compare unknowns against them.
  for (const it of allItems) hashesNeedingEmbedding.add(it.titleHash);

  const cacheKeys = Array.from(hashesNeedingEmbedding).map((h) => `${EMBED_CACHE_PREFIX}${h}`);
  const cached = await getCachedJsonBatch(cacheKeys);

  const embedByHash = new Map<string, Float32Array>();
  for (const it of allItems) {
    const raw = cached.get(`${EMBED_CACHE_PREFIX}${it.titleHash}`);
    if (typeof raw === 'string') {
      const v = base64ToFloat32(raw);
      if (v) embedByHash.set(it.titleHash, v);
    }
  }

  // ─── 2. Embed whatever's still missing ───
  const itemsToEmbed = allItems.filter((it) => !embedByHash.has(it.titleHash));
  if (itemsToEmbed.length > 0) {
    const texts = itemsToEmbed.map(inputTextFor);
    const fresh = await embedBatch(texts);

    // Persist new embeddings (fire-and-forget — failures just mean the
    // next refresh re-embeds the same items, which is cheap).
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < itemsToEmbed.length; i++) {
      const v = fresh[i];
      if (!v) continue;
      embedByHash.set(itemsToEmbed[i]!.titleHash, v);
      writes.push(
        setCachedJson(
          `${EMBED_CACHE_PREFIX}${itemsToEmbed[i]!.titleHash}`,
          float32ToBase64(v),
          EMBED_TTL_S,
        ),
      );
    }
    // Don't block on these — Redis writes for embedding cache aren't
    // critical-path. If any fail the next pass re-embeds (~1 cent total).
    Promise.allSettled(writes).then(() => undefined);
  }

  // ─── 3. Greedy clustering ───
  // For each unknown, find the highest-similarity neighbour among items
  // that already have a canonical assignment (either pre-known, or
  // assigned earlier in this loop). When nothing crosses the threshold
  // it becomes its own canonical.
  //
  // The order we process unknowns matters for borderline cases, so we
  // sort by publishedAt DESC — older items have had more time to
  // accumulate followers, so they make better cluster representatives.
  const sortedUnknowns = [...unknowns].sort((a, b) => b.publishedAt - a.publishedAt);

  // Build a set of (hash, embedding) tuples we can compare against.
  // Starts with all `knownMap` entries (existing canonicals from a
  // previous run) and grows as we classify unknowns.
  const candidates: Array<{ hash: string; embed: Float32Array }> = [];
  for (const it of allItems) {
    if (knownMap.has(it.titleHash)) {
      const e = embedByHash.get(it.titleHash);
      if (e) candidates.push({ hash: it.titleHash, embed: e });
    }
  }

  const writesDecisions: Promise<unknown>[] = [];
  let mergedCount = 0;
  let newCanonicalCount = 0;
  let unembeddable = 0;

  for (const item of sortedUnknowns) {
    const myEmbed = embedByHash.get(item.titleHash);
    if (!myEmbed) {
      // Embedding API didn't return anything — fall back to self-canonical
      // on the short ineligible TTL so we retry next pass.
      knownMap.set(item.titleHash, item.titleHash);
      writesDecisions.push(
        setCachedJson(
          `${DEDUP_CACHE_PREFIX}${item.titleHash}`,
          { canonical: item.titleHash } as CachedDedupDecision,
          6 * 60 * 60, // 6h — same as the LLM path's INELIGIBLE TTL
        ),
      );
      unembeddable++;
      continue;
    }

    let bestSim = -1;
    let bestCanonical: string | null = null;
    for (const cand of candidates) {
      const sim = cosineSim(myEmbed, cand.embed);
      if (sim > bestSim) {
        bestSim = sim;
        bestCanonical = knownMap.get(cand.hash) ?? cand.hash;
      }
    }

    const canonical = bestSim >= THRESHOLD && bestCanonical
      ? bestCanonical
      : item.titleHash;
    knownMap.set(item.titleHash, canonical);
    if (canonical === item.titleHash) {
      newCanonicalCount++;
    } else {
      mergedCount++;
    }
    // Persist decision on the long TTL — embedding clusters are stable.
    writesDecisions.push(
      setCachedJson(
        `${DEDUP_CACHE_PREFIX}${item.titleHash}`,
        { canonical } as CachedDedupDecision,
        DEDUP_TTL_S,
      ),
    );

    // Newly classified item joins the candidate pool so subsequent
    // unknowns can merge into it. This is what makes a 5-outlet wire
    // story turn into ONE cluster instead of 5 singleton clusters.
    candidates.push({ hash: item.titleHash, embed: myEmbed });
  }

  await Promise.allSettled(writesDecisions);

  console.log(
    `[live-news:dedup-embed] unknowns=${unknowns.length} merged=${mergedCount} ` +
    `new=${newCanonicalCount} unembeddable=${unembeddable} threshold=${THRESHOLD}`,
  );
}
