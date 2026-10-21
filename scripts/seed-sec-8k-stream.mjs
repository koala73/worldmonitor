#!/usr/bin/env node

// Seeds the market-wide stream of recent SEC 8-K material-event filings from the
// EDGAR "latest filings" Atom feed (issue #5695). Routine disclosure items
// (earnings exhibits, Reg FD) are filtered out; only genuinely material item
// codes survive. Each run merges into the previous snapshot so the stream holds
// a rolling window across cron gaps and quiet weekend stretches.

import { loadEnvFile, readSeedSnapshot, runSeed, withRetry, resolveProxy, curlFetch } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

export const SEC_8K_STREAM_KEY = 'intelligence:sec-8k-stream:v1';
const SEC_8K_STREAM_TTL_SECONDS = 7 * 24 * 3600;
export const SEC_8K_STREAM_MAX_STALE_MIN = 120;
const MAX_STREAM_EVENTS = 200;
const STREAM_WINDOW_MS = 7 * 24 * 3600 * 1000;
// Tolerates ordinary clock skew between the SEC feed and this runner; anything
// further into the future is malformed, not early.
const FUTURE_SKEW_TOLERANCE_MS = 60 * 60 * 1000;
// A market-wide 7-day window that falls below this is decaying, not quiet: one
// feed page alone yields ~75 material events. Floor is well below healthy
// yield so quiet weekends still publish, but high enough that partial Atom
// parse decay cannot stay green at a hollow ~20-event stream.
export const MIN_STREAM_EVENTS = 50;

// SEC requires a declared User-Agent identifying the requester (no browser
// spoofing) — same convention as scripts/seed-regulatory-actions.mjs.
const SEC_USER_AGENT = 'WorldMonitor/2.0 (monitor@worldmonitor.app)';

// Material 8-K item codes — must equal the high+medium materiality codes in
// server/_shared/sec-edgar.ts MATERIAL_8K_ITEMS (asserted by
// tests/sec-corporate-intel.test.mts). Kept inline because nixpacks seed
// bundles cannot import outside scripts/.
export const MATERIAL_ITEM_CODES = new Set([
  '1.01', '1.02', '1.03', '1.04', '1.05',
  '2.01', '2.02', '2.03', '2.04', '2.05', '2.06',
  '3.01', '3.02', '3.03',
  '4.01', '4.02',
  '5.01', '5.02', '5.03', '5.05', '5.08',
]);

const FEED_URL = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include&count=100&output=atom';

function unescapeXml(text) {
  return String(text ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function isSecGovUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    return url.protocol === 'https:' && (url.hostname === 'www.sec.gov' || url.hostname === 'sec.gov');
  } catch {
    return false;
  }
}

// Parses one EDGAR getcurrent Atom feed document into raw filing entries.
// Entry shape in the feed:
//   <title>8-K - Company Name (0001289848) (Filer)</title>
//   <link ... href="https://www.sec.gov/Archives/edgar/data/.../...-index.htm"/>
//   <summary type="html"> &lt;b&gt;Filed:&lt;/b&gt; 2026-07-27 &lt;b&gt;AccNo:&lt;/b&gt; 0001628280-26-049857 ...
//     &lt;br&gt;Item 5.02: Departure of Directors ...</summary>
//   <updated>2026-07-27T17:29:58-04:00</updated>
export function parse8kAtomFeed(xml) {
  const events = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  let match;
  while ((match = entryRegex.exec(String(xml ?? ''))) !== null) {
    const block = match[1];
    const rawTitle = unescapeXml((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const titleMatch = rawTitle.match(/^\s*(8-K(?:\/A)?)\s+-\s+(.+?)\s+\((\d{7,10})\)/);
    if (!titleMatch) continue;
    const form = titleMatch[1];
    const company = titleMatch[2].trim();
    const cik = titleMatch[3].padStart(10, '0');

    // Only sec.gov links are stored: the stream is rendered to API/MCP
    // consumers, so an unexpected host in the feed must not ride through.
    const linkMatch = block.match(/<link[^>]*href=["']([^"']+)["']/i);
    const url = linkMatch && isSecGovUrl(unescapeXml(linkMatch[1])) ? unescapeXml(linkMatch[1]) : '';

    const summary = unescapeXml((block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i) || [])[1] || '');
    const accession = (summary.match(/AccNo:<\/b>\s*([0-9-]+)/) || [])[1] || '';

    const items = [];
    const itemRegex = /Item\s+(\d+\.\d{2}):\s*([^<\n]+)/g;
    let itemMatch;
    while ((itemMatch = itemRegex.exec(summary)) !== null) {
      items.push({ code: itemMatch[1], description: itemMatch[2].trim() });
    }

    const updated = (block.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i) || [])[1] || '';
    const filedAtMs = Date.parse(updated.trim()) || 0;

    events.push({ company, cik, form, accession, filedAtMs, items, url });
  }
  return events;
}

export function filterMaterialEvents(events) {
  return events
    .map(event => ({
      ...event,
      items: event.items.filter(item => MATERIAL_ITEM_CODES.has(item.code)),
    }))
    .filter(event => event.items.length > 0 && event.accession && event.filedAtMs > 0);
}

// Merge freshly fetched events into the previous snapshot: dedupe by accession
// (newest fetch wins), drop events older than the rolling window, newest first.
export function mergeEventWindow(previousEvents, freshEvents, nowMs) {
  const byAccession = new Map();
  for (const event of Array.isArray(previousEvents) ? previousEvents : []) {
    if (event?.accession) byAccession.set(event.accession, event);
  }
  for (const event of freshEvents) {
    byAccession.set(event.accession, event);
  }
  return [...byAccession.values()]
    // Bounded on BOTH sides: a malformed <updated> or clock skew would
    // otherwise pin a future-dated event at the top of the stream forever,
    // re-merged on every run and unclearable without deleting the key.
    .filter(event => nowMs - event.filedAtMs < STREAM_WINDOW_MS
      && event.filedAtMs - nowMs < FUTURE_SKEW_TOLERANCE_MS)
    .sort((a, b) => b.filedAtMs - a.filedAtMs)
    .slice(0, MAX_STREAM_EVENTS);
}

export function build8kStreamSnapshot(previous, xml, nowMs = Date.now()) {
  const parsed = parse8kAtomFeed(xml);
  if (parsed.length === 0) {
    const detail = /<entry[\s>]/i.test(String(xml ?? ''))
      ? 'contains entries but none parsed — Atom shape drift'
      : 'returned no entries';
    throw new Error(`SEC 8-K feed ${detail}`);
  }

  const fresh = filterMaterialEvents(parsed);
  if (fresh.length === 0) {
    // A syntactically valid page containing only routine disclosures does not
    // prove the market-wide material-event stream was freshly observed. Keep
    // the last-good snapshot and its original freshness instead.
    throw new Error('SEC 8-K feed contained no material events');
  }
  return {
    events: mergeEventWindow(previous?.events, fresh, nowMs),
    fetchedAt: new Date(nowMs).toISOString(),
  };
}

export function validate8kStream(data) {
  return Array.isArray(data?.events)
    && typeof data?.fetchedAt === 'string'
    && data.events.length >= MIN_STREAM_EVENTS;
}

async function fetchFeedXml() {
  try {
    return await withRetry(async () => {
      const resp = await fetch(FEED_URL, {
        headers: { 'User-Agent': SEC_USER_AGENT, Accept: 'application/atom+xml, application/xml, */*' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) throw Object.assign(new Error(`HTTP ${resp.status}`), { status: resp.status });
      return resp.text();
    }, 2, 2000);
  } catch (err) {
    const proxyAuth = resolveProxy();
    if (!proxyAuth) throw err;
    console.warn(`  Direct SEC feed fetch failed (${err?.message}); retrying via proxy`);
    return curlFetch(FEED_URL, proxyAuth, {
      'User-Agent': SEC_USER_AGENT,
      Accept: 'application/atom+xml, application/xml, */*',
    });
  }
}

async function fetch8kStream() {
  const [previous, xml] = await Promise.all([
    // strict: the rolling window IS the product. A transient Redis read failure
    // must abort the run (runSeed preserves last-good) rather than silently
    // republish a window truncated to whatever this one feed page returned.
    readSeedSnapshot(SEC_8K_STREAM_KEY, { strict: true }),
    fetchFeedXml(),
  ]);

  // A successful-but-empty response is not proof of a quiet market. Failing the
  // run preserves the prior seed metadata instead of relabeling old events as a
  // freshly observed window.
  return build8kStreamSnapshot(previous, xml);
}

if (process.argv[1]?.endsWith('seed-sec-8k-stream.mjs')) {
  runSeed('intelligence', 'sec-8k-stream', SEC_8K_STREAM_KEY, fetch8kStream, {
    ttlSeconds: SEC_8K_STREAM_TTL_SECONDS,
    validateFn: validate8kStream,
    declareRecords: (data) => data.events.length,
    sourceVersion: 'sec-edgar-getcurrent-atom-v1',
    schemaVersion: 1,
    maxStaleMin: SEC_8K_STREAM_MAX_STALE_MIN,
  });
}
