/**
 * v6 clustering — Gemini embedding cosine + greedy clustering for RSS
 * items. Reuses the embed/cosine helpers from `_shared/embeddings.ts`,
 * but does NOT depend on the legacy LLM dedup logic. Produces clusters
 * ready to write to the v6 digest (longest description, first image,
 * sources[]).
 *
 * # Threshold
 *
 * 0.7 default — broader clusters bias per the product spec. Tune via
 * the const below if results need adjusting.
 */

import { embedBatch, cosineSim, float32ToBase64, base64ToFloat32 } from '../../_shared/embeddings';
import { getCachedJsonBatch, setCachedJson } from '../../_shared/redis';
import type { RawRssItem } from './_normalize';

const THRESHOLD = 0.7;
const EMBED_CACHE_PREFIX = 'live-news:v6:embed:';
const EMBED_TTL_S = 24 * 60 * 60;
const MAX_INPUT_LEN = 400;

export interface ClusterSource {
  source: string;
  title: string;
  link: string;
  publishedAt: number;
}

/**
 * A clustered story ready to be written to the v6 digest. The wire
 * shape matches the iOS `NewsItem` decoder (with some fields populated
 * later by the enrichment cron).
 */
export interface ClusteredItem {
  /** Identity = canonical's titleHash. Used as Redis dedup key. */
  id: string;
  source: string;
  title: string;
  link: string;
  publishedAt: number;
  /** Longest plaintext RSS description across every cluster member.
   *  This is the v6 wire `summary` — no LLM rewriting, no licensing
   *  concern, just outlet-supplied content. */
  summary: string | null;
  /** First image URL found across cluster members (RSS-supplied). */
  imageUrl: string | null;
  /** Every outlet covering this story, canonical first. iOS renders
   *  this as the "Also covered by N outlets" affordance. */
  sources: ClusterSource[];
  isAlert: boolean;
  titleHash: string;
  // Enrichment-only fields — filled by the location-only LLM cron
  // (intel-news enrich.ts) on its next pass. Start null.
  location: { latitude: number; longitude: number } | null;
  locationName: string | null;
  country: string | null;
  region?: string;
  isConflict: boolean | null;
  confidence: number | null;
  rawDescription: string | null;
}

function inputTextFor(item: RawRssItem): string {
  const title = item.title.trim();
  const desc = (item.description || '').trim().slice(0, 300);
  const combined = desc ? `${title} — ${desc}` : title;
  return combined.slice(0, MAX_INPUT_LEN);
}

/**
 * Pick the cluster's canonical from its members. Rule:
 *   1. Lowest sourcePriority wins (1 = wires, beats 4 = analysis).
 *   2. Among same-priority, newest publishedAt wins.
 * Mirrors v1's representative-selection so feed continuity is preserved
 * when iOS switches between picker options.
 */
function pickCanonical(members: RawRssItem[]): RawRssItem {
  return [...members].sort((a, b) => {
    if (a.sourcePriority !== b.sourcePriority) return a.sourcePriority - b.sourcePriority;
    return b.publishedAt - a.publishedAt;
  })[0]!;
}

/** Longest plaintext description across the cluster — that's the v6
 *  wire summary. */
function pickLongestDescription(members: RawRssItem[]): string | null {
  let best = '';
  for (const m of members) {
    const d = (m.description || '').trim();
    if (d.length > best.length) best = d;
  }
  return best.length > 0 ? best : null;
}

/** First non-null image across the cluster. Members are tried in the
 *  same canonical-first ordering so the canonical's image takes priority. */
function pickFirstImage(members: RawRssItem[], canonical: RawRssItem): string | null {
  if (canonical.imageUrl) return canonical.imageUrl;
  for (const m of members) {
    if (m.imageUrl) return m.imageUrl;
  }
  return null;
}

/**
 * Main entry — embed all items, online-greedy-cluster them at THRESHOLD,
 * then post-process each cluster into the wire shape.
 *
 * Order of incoming items is preserved as the secondary "seen-first"
 * priority: when two items would cluster equally well with multiple
 * candidates, the first-seen wins. This is stable across cron runs.
 */
export async function clusterRssItems(items: RawRssItem[]): Promise<ClusteredItem[]> {
  if (items.length === 0) return [];

  // ── 1. Load cached embeddings ──
  const cacheKeys = items.map((it) => `${EMBED_CACHE_PREFIX}${it.titleHash}`);
  const cached = await getCachedJsonBatch(cacheKeys);

  const embedByHash = new Map<string, Float32Array>();
  for (const it of items) {
    const raw = cached.get(`${EMBED_CACHE_PREFIX}${it.titleHash}`);
    if (typeof raw === 'string') {
      const v = base64ToFloat32(raw);
      if (v) embedByHash.set(it.titleHash, v);
    }
  }

  // ── 2. Embed misses ──
  const toEmbed = items.filter((it) => !embedByHash.has(it.titleHash));
  if (toEmbed.length > 0) {
    const fresh = await embedBatch(toEmbed.map(inputTextFor));
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < toEmbed.length; i++) {
      const v = fresh[i];
      if (!v) continue;
      embedByHash.set(toEmbed[i]!.titleHash, v);
      writes.push(
        setCachedJson(
          `${EMBED_CACHE_PREFIX}${toEmbed[i]!.titleHash}`,
          float32ToBase64(v),
          EMBED_TTL_S,
        ),
      );
    }
    // Fire-and-forget — cache miss next run is a sub-cent re-embed.
    Promise.allSettled(writes).then(() => undefined);
  }

  // ── 3. Online greedy clustering ──
  // Each cluster identified by its canonical's titleHash. Members map
  // tracks every item that landed in each cluster.
  const clusterOf = new Map<string, string>();       // item.titleHash → canonical hash
  const members = new Map<string, RawRssItem[]>();   // canonical → members
  // For comparison we keep one representative embedding per cluster
  // (the first-seen item's vector). This bounds the cosine loop to
  // O(items × clusters), which is well under 1ms for our scale.
  const repEmbedByCanonical = new Map<string, Float32Array>();

  // Process oldest-first so older stories accrete younger reports.
  const sorted = [...items].sort((a, b) => a.publishedAt - b.publishedAt);

  for (const it of sorted) {
    const e = embedByHash.get(it.titleHash);
    if (!e) {
      // Embedding failed — fall back to singleton.
      clusterOf.set(it.titleHash, it.titleHash);
      members.set(it.titleHash, [it]);
      continue;
    }

    let bestSim = -1;
    let bestCanonical: string | null = null;
    for (const [canonical, repEmbed] of repEmbedByCanonical) {
      const s = cosineSim(e, repEmbed);
      if (s > bestSim) {
        bestSim = s;
        bestCanonical = canonical;
      }
    }

    if (bestSim >= THRESHOLD && bestCanonical) {
      clusterOf.set(it.titleHash, bestCanonical);
      members.get(bestCanonical)!.push(it);
    } else {
      // New cluster — this item is the representative.
      clusterOf.set(it.titleHash, it.titleHash);
      members.set(it.titleHash, [it]);
      repEmbedByCanonical.set(it.titleHash, e);
    }
  }

  // ── 4. Post-process into wire shape ──
  const clustered: ClusteredItem[] = [];
  for (const [canonicalHash, memberList] of members) {
    const canonical = pickCanonical(memberList);
    const longestDesc = pickLongestDescription(memberList);
    const firstImg = pickFirstImage(memberList, canonical);

    // sources[] — canonical first, then alternates by publishedAt DESC.
    const alternates = memberList
      .filter((m) => m.link !== canonical.link)
      .sort((a, b) => b.publishedAt - a.publishedAt);

    const sources: ClusterSource[] = [canonical, ...alternates].map((m) => ({
      source: m.source,
      title: m.title,
      link: m.link,
      publishedAt: m.publishedAt,
    }));

    clustered.push({
      id: canonicalHash,
      source: canonical.source,
      title: canonical.title,
      link: canonical.link,
      publishedAt: canonical.publishedAt,
      summary: longestDesc,
      imageUrl: firstImg,
      sources,
      isAlert: false,
      titleHash: canonical.titleHash,
      location: null,
      locationName: null,
      country: null,
      isConflict: null,
      confidence: null,
      rawDescription: longestDesc,  // mirror, used by enrich's title-only fallback
    });
  }

  // Sort newest-first
  clustered.sort((a, b) => b.publishedAt - a.publishedAt);

  return clustered;
}
