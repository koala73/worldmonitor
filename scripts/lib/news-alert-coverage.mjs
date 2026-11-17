// Only the notification worker reads history or evaluates a semantic suggestion.
// Neither result participates in publishing, scoring, rule matching or dedup.
import { newsPublisherCoverageKey } from '../shared/story-identity.js';
import storyKeys from './news-story-key.cjs';
import { defaultRedisPipeline } from './_upstash-pipeline.mjs';
import { EMBED_MODEL } from './brief-dedup-consts.mjs';
import { cosineSimilarity, embedBatch, normalizeForEmbedding } from './brief-embedding.mjs';

const DAY = storyKeys.NEWS_STORY_DEDUP_TTL_SECONDS * 1000;

export async function refreshPublisherCounts(events, now = Date.now(), pipeline = defaultRedisPipeline) {
  const reads = new Map();
  for (const event of events) {
    if (event.eventType !== 'rss_alert' || event.userId) continue;
    // A held notification may have an earlier snapshot. On failure render
    // the producer's original per-build count, never that expired snapshot.
    delete event.observedPublisherCount;
    const key = newsPublisherCoverageKey(event.variant, event.payload?.title);
    if (!key) continue;
    if (!reads.has(key)) reads.set(key, []);
    reads.get(key).push(event);
  }
  if (!reads.size) return;
  const commands = [...reads.keys()].map(key => ['ZRANGEBYSCORE', key, `(${now - DAY}`, now]);
  const rows = await pipeline(commands, { timeoutMs: 500 });
  let i = 0;
  for (const group of reads.values()) {
    const families = rows?.[i++]?.result;
    if (!Array.isArray(families) || !families.length) continue;
    for (const event of group) event.observedPublisherCount = families.length;
  }
}

// Read at most 64 recent eligible anchors per edition. Keep the actual delivery
// decisions as anchors, even when the shadow model would have merged two.
export async function observeSemanticMatch(event, pipeline = defaultRedisPipeline, embed = embedBatch) {
  const title = event.payload?.title;
  if (event.userId || event.eventType !== 'rss_alert' || !event.variant || typeof title !== 'string' || !title
    || !storyKeys.reachesRealtimeRules(event.severity, event.payload.importanceScore)) return;
  const at = event.publishedAt;
  if (!Number.isFinite(at) || at <= Date.now() - DAY || at > Date.now()) return;
  const key = `shadow:news-alert-anchors:v1:${event.variant}`;
  const input = title.slice(0, 2000);
  const rows = await pipeline([
    ['ZREMRANGEBYSCORE', key, '-inf', at - DAY],
    ['ZREVRANGEBYSCORE', key, at, `(${at - DAY}`, 'LIMIT', 0, 64],
    ['ZADD', key, 'NX', at, input],
    ['EXPIRE', key, DAY / 1000],
  ]);
  if (!Array.isArray(rows?.[1]?.result) || rows[2]?.result !== 1) return;
  const id = newsPublisherCoverageKey(event.variant, title);
  const anchors = rows[1].result.filter(t => typeof t === 'string' && newsPublisherCoverageKey(event.variant, t) !== id);
  let best = null;
  if (anchors.length) {
    const vectors = await embed([input, ...anchors].map(normalizeForEmbedding));
    for (const [i, anchor] of anchors.entries()) {
      const score = cosineSimilarity(vectors[0], vectors[i + 1]);
      if (!best || score > best.score) best = { anchor: newsPublisherCoverageKey(event.variant, anchor), score };
    }
  }
  const record = {
    at, edition: event.variant, id, eligible: true, model: EMBED_MODEL,
    importanceScore: event.payload.importanceScore, candidates: anchors.length,
    anchor: best?.anchor ?? null, score: best?.score ?? null, suggestedMatch: (best?.score ?? 0) >= 0.85,
  };
  console.info('[news-alert-semantic-shadow]', JSON.stringify(record));
}
