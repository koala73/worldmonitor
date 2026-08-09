/**
 * Runtime-neutral helpers for the seeded news:insights:v1 snapshot.
 * Shared by the dashboard loader and MCP registry so freshness and source
 * normalization do not drift across the two agent-facing surfaces.
 */

export const INSIGHTS_MAX_AGE_MS = 60 * 60 * 1000;

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
