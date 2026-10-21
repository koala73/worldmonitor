/**
 * Runtime-neutral helpers for the seeded news:insights:v1 snapshot.
 * Shared by the dashboard loader and MCP registry so freshness and source
 * normalization do not drift across the two agent-facing surfaces.
 */

export const INSIGHTS_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Hard ceiling on how old a snapshot may be and still be worth SERVING as
 * last-known-good, for consumers that choose to (today: the MCP
 * `get_world_brief`, which reports `stale: true` between these two bounds
 * instead of failing — PR #7271).
 *
 * This exists because the producer's Redis TTL cannot be borrowed as a bound.
 * `runSeed`'s LKG paths call `preserveExistingKeys()` on both fetch failure
 * (`scripts/_seed-utils.mjs:2303`) and validation skip (`:2450`); that resolves
 * the canonical key via `defaultPreservationKeys` (`:2183-2188`) into
 * `extendExistingTtl(keys, ttlSeconds)` (`:2199, 2209`), which issues
 * `EXPIRE <key> <ttl>` (`:1133`) — a full RESET, not a decrement. Every failed
 * run therefore slides the key another 3h forward while `generatedAt` never
 * advances, so a multi-day outage would keep a multi-day-old brief alive and
 * nominally "within TTL". That sliding window is the producer protecting its
 * data; it says nothing about whether the content is still worth reading.
 *
 * Deliberately equal to the seeder's own `CACHE_TTL` (3h) so the ceiling is one
 * full retention window rather than a second invented number — but enforced
 * HERE, against the `generatedAt` clock, which nothing renews.
 */
export const INSIGHTS_MAX_SERVEABLE_AGE_MS = 3 * 60 * 60 * 1000;

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clipText(value, maxLen) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > maxLen ? `${text.slice(0, maxLen - 1).trim()}...` : text;
}

function normalizePublishedAt(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function normalizeInsightSourceUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

/**
 * Normalize a producer/digest source. `fallback` is used only for fields
 * absent from the primary record; `allowEmptyUrl` is for citation-indexed
 * seeded sources whose explicit no-link fallback must retain its position.
 */
export function normalizeInsightSource(candidate, options = {}) {
  const item = isRecord(candidate) ? candidate : {};
  const fallback = isRecord(options.fallback) ? options.fallback : {};
  const urlOrder = options.urlOrder === 'link-first' ? 'link-first' : 'url-first';
  const urlValue = urlOrder === 'link-first'
    ? item.link ?? item.url ?? item.primaryLink ?? fallback.link ?? fallback.url ?? fallback.primaryLink
    : item.url ?? item.link ?? item.primaryLink ?? fallback.url ?? fallback.link ?? fallback.primaryLink;
  const url = normalizeInsightSourceUrl(urlValue);
  const title = clipText(item.title ?? item.primaryTitle ?? fallback.title ?? fallback.primaryTitle, 160);
  const source = clipText(item.source ?? item.primarySource ?? fallback.source ?? fallback.primarySource, 80);
  if ((!url && options.allowEmptyUrl !== true) || !title || !source) return null;
  const publishedAt = normalizePublishedAt(
    item.publishedAt ?? item.pubDate ?? item.date ?? fallback.publishedAt ?? fallback.pubDate ?? fallback.date,
  );
  return publishedAt ? { title, source, url, publishedAt } : { title, source, url };
}

export function collectInsightSources(candidates, maxSources = 6, options = {}) {
  const out = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const source = normalizeInsightSource(candidate, options);
    if (!source || !source.url || seen.has(source.url)) continue;
    out.push(source);
    seen.add(source.url);
    if (out.length >= maxSources) break;
  }
  return out;
}

/**
 * Names WHICH acceptance gate rejects a snapshot (null = accepted). A stale
 * producer and a schema regression need opposite responses, so alarms built
 * on the boolean alone were undiagnosable (WORLDMONITOR-YJ). Reasons are a
 * bounded enum — safe for Sentry messages and log grouping.
 */
export function insightsSnapshotRejection(raw, nowMs = Date.now()) {
  if (!isRecord(raw) || !Array.isArray(raw.topStories) || raw.topStories.length === 0) return 'malformed-snapshot';
  if (typeof raw.generatedAt !== 'string') return 'missing-generated-at';
  const generatedMs = Date.parse(raw.generatedAt);
  if (!Number.isFinite(generatedMs)) return 'missing-generated-at';
  if (generatedMs > nowMs) return 'future-generated-at';
  if (nowMs - generatedMs >= INSIGHTS_MAX_AGE_MS) return 'stale-snapshot';
  return null;
}

export function isAcceptedInsightsSnapshot(raw, nowMs = Date.now()) {
  return insightsSnapshotRejection(raw, nowMs) === null;
}
