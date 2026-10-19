// Mirrored in api/_china-futures-contract.js for the self-contained Edge runtime.
// Railway builds scripts/ only. The parity test guards these two copies.
export const CACHE_KEY = 'news:china-futures:shfe:notices:v1';
export const SOURCE_ID = 'cn-shfe-notices';
export const SOURCE_NAME = 'SHFE (China)';
export const SOURCE_URL = 'https://www.shfe.com.cn/publicnotice/notice/';
export const MAX_STALE_MIN = 24 * 60;
export const MAX_CONTENT_AGE_MIN = 30 * 24 * 60;
export const TTL_SECONDS = 7 * 24 * 3600;

export function validateSnapshot(value, now = Date.now()) {
  if (!value || value.schemaVersion !== 1 || value.sourceId !== SOURCE_ID
    || !Number.isSafeInteger(value.fetchedAt) || value.fetchedAt <= 0 || value.fetchedAt > now
    || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 100) return false;
  const ids = new Set();
  for (const item of value.items) {
    if (!item || item.sourceId !== SOURCE_ID || item.datePrecision !== 'day'
      || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 1000
      || /[\u0000-\u001f\u007f]/.test(item.title)
      || !/^[a-f0-9]{64}$/.test(item.revision ?? '')
      || !/^20\d{2}-\d{2}-\d{2}$/.test(item.publicationDate ?? '')) return false;
    const stamp = Date.parse(`${item.publicationDate}T00:00:00+08:00`);
    if (!Number.isFinite(stamp) || stamp > value.fetchedAt
      || new Date(stamp + 8 * 3600_000).toISOString().slice(0, 10) !== item.publicationDate
      || item.publishedAt !== new Date(stamp).toISOString()) return false;
    const match = typeof item.sourceUrl === 'string' && item.sourceUrl.match(/^https:\/\/www\.shfe\.com\.cn\/publicnotice\/notice\/(\d{6})\/t(\d{8})_(\d+)\.html$/);
    if (!match || match[2] !== item.publicationDate.replaceAll('-', '') || match[1] !== match[2].slice(0, 6)
      || item.documentId !== `${SOURCE_ID}:${match[2]}:${match[3]}` || ids.has(item.documentId)) return false;
    ids.add(item.documentId);
  }
  return true;
}

export function contentMeta(value) {
  const times = value.items.map((item) => Date.parse(item.publishedAt));
  return { newestItemAt: Math.max(...times), oldestItemAt: Math.min(...times) };
}
