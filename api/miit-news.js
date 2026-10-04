import { getCorsHeaders, getPublicCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';
import { readRawJsonFromUpstash, setCachedData } from './_upstash-json.js';
import { captureSilentError } from './_sentry-edge.js';

export const config = { runtime: 'edge' };

const SOURCE_URL = 'https://www.miit.gov.cn/';
const CACHE_KEY = 'miit:news-listing:v1';
const CACHE_TTL_SECONDS = 300;
const XML_CONTROLS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

function decodeText(value) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, code) => {
    if (!code.startsWith('#')) return named[code.toLowerCase()];
    const point = code[1].toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point) : entity;
  }).replace(XML_CONTROLS, '').trim();
}

function cdata(value) {
  return `<![CDATA[${value.replace(XML_CONTROLS, '').split(']]>').join(']]]]><![CDATA[>')}]]>`;
}

function listingText(value) {
  let previous;
  do {
    previous = value;
    value = value.replace(/<[^<>]*>/g, '');
  } while (value !== previous);
  return value;
}

export function parseMiitNews(html, nowMs = Date.now()) {
  const items = new Map();
  for (const match of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const row = match[1];
    const day = row.match(/<span\b[^>]*>\s*(\d{4}-\d{2}-\d{2})\s*<\/span>/i)?.[1];
    const anchor = row.match(/<a\b([^>]*)>([\s\S]*?)<\/a>/i);
    const href = anchor?.[1].match(/\shref\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!day || !anchor || !href) continue;
    const date = new Date(`${day}T00:00:00+08:00`);
    if (!Number.isFinite(date.getTime()) || date.getTime() > nowMs || nowMs - date.getTime() > 7 * 86400000
      || new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10) !== day) continue;
    let url;
    try { url = new URL(decodeText(href), SOURCE_URL); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'www.miit.gov.cn'
      || url.username || url.password || url.port
      || !/^\/(?:[\w-]+\/)+art\/\d{4}\/art_[\da-f]+\.html$/i.test(url.pathname)) continue;
    url.protocol = 'https:';
    url.search = '';
    url.hash = '';
    const title = decodeText(anchor[1].match(/\stitle\s*=\s*(["'])(.*?)\1/i)?.[2]
      ?? listingText(anchor[2]));
    if (!title || items.has(url.href)) continue;
    items.set(url.href, { title, link: url.href, date: date.toISOString() });
  }
  return [...items.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);
}

export function renderMiitRss(items) {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
<title>MIIT (China)</title><link>${SOURCE_URL}</link><language>zh-CN</language>
<description>Official Ministry of Industry and Information Technology news</description>
${items.map((item) => `<item><title>${cdata(item.title)}</title><link>${item.link}</link>
<guid>${item.link}</guid><pubDate>${new Date(item.date).toUTCString()}</pubDate>
<source url="${SOURCE_URL}">MIIT (China)</source></item>`).join('\n')}
</channel></rss>`;
}

export default async function handler(req, ctx) {
  const cors = getCorsHeaders(req);
  if (isDisallowedOrigin(req)) return jsonResponse({ error: 'Origin not allowed' }, 403, cors);
  try {
    let items = null;
    try {
      const cached = await readRawJsonFromUpstash(CACHE_KEY);
      if (Array.isArray(cached) && cached.length > 0) items = cached;
    } catch { /* The source remains readable when Redis is unavailable. */ }
    if (!items) {
      const response = await fetch(SOURCE_URL, {
        headers: { 'User-Agent': 'WorldMonitor/1.0 (+https://worldmonitor.app)', Accept: 'text/html' },
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`MIIT HTTP ${response.status}`);
      const html = await response.text();
      if (html.length > 1_000_000) throw new Error('MIIT listing exceeds size limit');
      items = parseMiitNews(html);
      if (items.length === 0) throw new Error('MIIT listing has no dated official articles');
      try { await setCachedData(CACHE_KEY, items, CACHE_TTL_SECONDS); } catch { /* Cache is a load shield. */ }
    }
    return new Response(renderMiitRss(items), {
      headers: {
        ...getPublicCorsHeaders(),
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=300, s-maxage=300',
      },
    });
  } catch (error) {
    // AbortSignal.timeout(10000) on the official listing fetch surfaces as
    // TimeoutError / AbortError when www.miit.gov.cn is slow or unreachable
    // from the edge. The handler already returns 502; downgrade the Sentry
    // capture to warning so one-shot upstream timeouts stay queryable without
    // drowning real listing bugs (empty parse, HTTP non-ok, size limit).
    // Same gate as api/brief/carousel and api/_relay (WORLDMONITOR-17C).
    const errName = error instanceof Error ? error.name : '';
    const isTransientTimeout = errName === 'AbortError' || errName === 'TimeoutError';
    captureSilentError(error, {
      tags: { route: 'api/miit-news', step: 'listing' },
      fingerprint: ['api/miit-news', 'listing', error instanceof Error ? error.name : 'Error'],
      ctx,
      ...(isTransientTimeout ? { level: 'warning' } : {}),
    });
    return jsonResponse({ error: 'MIIT official news unavailable' }, 502, {
      ...cors, 'Cache-Control': 'no-store',
    });
  }
}
