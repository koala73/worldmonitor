import { createHash } from 'node:crypto';
import { decodeHtmlEntities } from '../_html-entities.mjs';

export const SHFE_NOTICES_URL = 'https://www.shfe.com.cn/publicnotice/notice/';
export const SHFE_SOURCE_ID = 'cn-shfe-notices';
const MAX_BYTES = 1_000_000;
const MAX_ITEMS = 100;
const CHINA_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

function text(value) {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, ''))
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function attribute(value, name) {
  return value.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'))?.[2] ?? '';
}

/** The publisher supplies a calendar day, not an intraday publication time. */
function publicationTime(day, now) {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(day)) return null;
  const timestamp = Date.parse(`${day}T00:00:00+08:00`);
  if (!Number.isFinite(timestamp) || timestamp > now
    || new Date(timestamp + CHINA_UTC_OFFSET_MS).toISOString().slice(0, 10) !== day) return null;
  return new Date(timestamp).toISOString();
}

export function parseShfeNotices(html, now = Date.now()) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_BYTES) throw new Error('SHFE listing exceeds size limit');
  if (!Number.isFinite(now)) throw new TypeError('Invalid collection time');
  const clean = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const rows = clean.split(/<div\b[^>]*class\s*=\s*["']table_item_info["'][^>]*>/i).slice(1);
  const items = new Map();
  for (const row of rows) {
    const anchor = row.match(/class\s*=\s*["']info_item_title["'][^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/i);
    const day = row.match(/class\s*=\s*["']info_item_date["'][^>]*>\s*(\d{4}-\d{2}-\d{2})\s*<\/div>/i)?.[1];
    if (!anchor || !day) continue;
    const publishedAt = publicationTime(day, now);
    if (!publishedAt) continue;
    let url;
    try { url = new URL(decodeHtmlEntities(attribute(anchor[1], 'href')), SHFE_NOTICES_URL); } catch { continue; }
    const path = url.pathname.match(/^\/publicnotice\/notice\/(\d{6})\/t(\d{8})_(\d+)\.html$/);
    if (url.origin !== 'https://www.shfe.com.cn' || url.username || url.password || !path
      || path[2] !== day.replaceAll('-', '') || path[1] !== path[2].slice(0, 6)) continue;
    url.hash = '';
    url.search = '';
    const title = text(attribute(anchor[1], 'title') || anchor[2]);
    if (!title || title.length > 1000 || items.has(url.href)) continue;
    items.set(url.href, {
      documentId: `${SHFE_SOURCE_ID}:${path[2]}:${path[3]}`,
      revision: createHash('sha256').update(JSON.stringify([title, day])).digest('hex'),
      sourceId: SHFE_SOURCE_ID,
      sourceUrl: url.href,
      title,
      publicationDate: day,
      publishedAt,
      datePrecision: 'day',
    });
  }
  return [...items.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.documentId.localeCompare(b.documentId)).slice(0, MAX_ITEMS);
}

export async function fetchShfeNotices({ fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now() } = {}) {
  const response = await fetchImpl(SHFE_NOTICES_URL, {
    headers: { 'User-Agent': 'WorldMonitor/1.0 (+https://worldmonitor.app)', Accept: 'text/html' },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`SHFE HTTP ${response.status}`);
  if (!/^text\/html(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('SHFE expected HTML');
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error('SHFE listing exceeds size limit');
  }
  if (!response.body) throw new Error('SHFE response body missing');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let html = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) { await reader.cancel(); throw new Error('SHFE listing exceeds size limit'); }
      html += decoder.decode(value, { stream: true });
    }
    html += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  const items = parseShfeNotices(html, now);
  // An unchanged nonempty listing is valid. Empty/challenge/changed markup is
  // not proof that the publisher has no notices: preserve the last-good seed.
  if (items.length === 0) throw new Error('SHFE listing has no valid dated notices');
  return { schemaVersion: 1, sourceId: SHFE_SOURCE_ID, fetchedAt: now, items };
}
