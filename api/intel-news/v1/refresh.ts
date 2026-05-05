/**
 * HTTP entry — `GET /api/intel-news/v1/refresh`
 *
 * Cron-only endpoint. Sequentially refreshes all 10 GDELT topic
 * accumulators with 5.5-second pacing between calls (per GDELT's
 * fair-use rate limit).
 *
 * Triggered by Vercel cron (configured in `vercel.json`'s `crons` block,
 * default schedule `*​/15 * * * *`). Manual invocation requires the
 * `CRON_SECRET` env var as a Bearer token — Vercel auto-attaches this
 * header to scheduled cron requests when the secret is set.
 *
 * # Why Node.js runtime (not edge)
 *
 * Vercel Edge functions cap initial response at ~25 s on Pro plan.
 * Node.js runtime supports `maxDuration: 300` on Pro, so 55 s of
 * sequential GDELT fan-out fits comfortably.
 *
 * # Why fully inlined (no imports from server/)
 *
 * The project uses `"type": "module"` in package.json, which means
 * Node.js ESM resolution requires explicit `.js` extensions on every
 * relative import. Importing `server/intel-news/v1/refresh` would
 * pull in a transitive chain of ~10 files that all need extension
 * fixes. Inlining keeps this cron self-contained and isolated from
 * the rest of the codebase. The duplication is intentional — the
 * read-side (`list-headlines.ts`) still imports the helpers normally
 * since it runs on edge runtime where the bundler handles extensions.
 */

import type { IncomingMessage, ServerResponse } from 'http';

export const config = {
  // 60 s gives the sequential 10-topic fan-out (≈55 s) plus 5 s housekeeping
  // budget. Pro plan supports up to 300 s if we ever need more.
  maxDuration: 60,
};

// ─────────────────────────────────────────────────────────────────────────────
// Topics (kept in sync with server/intel-news/v1/_topics.ts — same source-of-truth)
// ─────────────────────────────────────────────────────────────────────────────

interface IntelTopic {
  id: string;
  label: string;
  query: string;
}

const INTEL_TOPICS: IntelTopic[] = [
  {
    id: 'conflict',
    label: 'CONFLICT',
    query:
      '("armed conflict" OR airstrike OR "air strike" OR "drone strike" OR ' +
      '"missile strike" OR "missile attack" OR "rocket attack" OR shelling OR ' +
      'artillery OR "ground assault" OR firefight OR "armed clash" OR ' +
      'ceasefire OR "civilian casualties" OR "war crime" OR insurgent OR ' +
      'militant OR Hezbollah OR Hamas OR Houthi OR offensive OR "military strike") ' +
      'sourcelang:eng',
  },
  {
    id: 'cyber',
    label: 'CYBER',
    query:
      '(cyberattack OR "cyber attack" OR cybersecurity OR ransomware OR hacking OR hacker OR ' +
      '"data breach" OR "security breach" OR "data leak" OR phishing OR malware OR ' +
      '"zero-day" OR DDoS OR APT OR "supply chain attack" OR "denial of service" OR ' +
      '"hacked" OR "exploit") sourcelang:eng',
  },
  {
    id: 'military',
    label: 'MILITARY',
    query:
      '("armed forces" OR Pentagon OR "missile strike" OR "drone strike" OR airstrike OR ' +
      '"air strike" OR "troop deployment" OR "military exercise" OR "naval exercise" OR ' +
      '"military operation" OR "military aid" OR ceasefire OR "fighter jet" OR ' +
      '"ground forces" OR "missile launch" OR "war crime" OR "military base" OR ' +
      '"defense ministry" OR "joint exercise") sourcelang:eng',
  },
  {
    id: 'nuclear',
    label: 'NUCLEAR',
    query:
      '("nuclear weapon" OR "nuclear program" OR "nuclear test" OR "nuclear deal" OR ' +
      '"nuclear power" OR "nuclear plant" OR "nuclear reactor" OR "nuclear missile" OR ' +
      '"nuclear arsenal" OR "nuclear threat" OR "nuclear talks" OR uranium OR ' +
      '"uranium enrichment" OR plutonium OR IAEA OR "atomic bomb" OR "atomic energy" OR ' +
      '"non-proliferation" OR "nuclear inspection") sourcelang:eng',
  },
  {
    id: 'sanctions',
    label: 'SANCTIONS',
    query:
      '(sanctions OR sanctioned OR embargo OR OFAC OR "export controls" OR tariff OR ' +
      'tariffs OR "trade war" OR "frozen assets" OR blacklisted OR "asset freeze" OR ' +
      '"trade restriction" OR "economic pressure" OR "secondary sanctions" OR ' +
      '"sanctions package" OR "sanctions list" OR "designated entity") sourcelang:eng',
  },
  {
    id: 'intelligence',
    label: 'INTELLIGENCE',
    query:
      '(espionage OR spy OR CIA OR MI6 OR Mossad OR FSB OR FBI OR ' +
      '"intelligence agency" OR "intelligence officer" OR "intelligence service" OR ' +
      'covert OR surveillance OR wiretap OR "classified document" OR informant OR ' +
      '"intelligence leak" OR counterintelligence OR "double agent" OR ' +
      '"national security" OR defector) sourcelang:eng',
  },
  {
    id: 'maritime',
    label: 'MARITIME',
    query:
      '(warship OR "naval blockade" OR "naval base" OR "naval drill" OR "naval ship" OR ' +
      'piracy OR "Strait of Hormuz" OR "South China Sea" OR "Suez Canal" OR ' +
      '"shipping lane" OR "oil tanker" OR freighter OR submarine OR "coast guard" OR ' +
      '"Bab al-Mandeb" OR "Red Sea attack" OR "naval patrol" OR ' +
      '"freedom of navigation" OR "maritime security") sourcelang:eng',
  },
  {
    id: 'business',
    label: 'BUSINESS',
    query:
      '(earnings OR IPO OR "stock market" OR "interest rate" OR "Federal Reserve" OR ' +
      '"central bank" OR merger OR acquisition OR layoffs OR "quarterly results" OR ' +
      '"Wall Street" OR Nasdaq OR "Dow Jones" OR inflation OR recession OR GDP OR ' +
      '"earnings report" OR "stock price" OR "market crash" OR "rate cut" OR ' +
      '"rate hike" OR "trade deal" OR "corporate profits") sourcelang:eng',
  },
  {
    id: 'scitech',
    label: 'SCI & TECH',
    query:
      '("artificial intelligence" OR "machine learning" OR semiconductor OR microchip OR ' +
      '"quantum computing" OR biotech OR vaccine OR "clinical trial" OR ' +
      '"space launch" OR rocket OR satellite OR "renewable energy" OR ' +
      '"nuclear fusion" OR "electric vehicle" OR robotics OR startup OR ' +
      '"venture capital" OR "AI model" OR "drug approval" OR "FDA approval" OR ' +
      '"genome editing" OR "scientific breakthrough") sourcelang:eng',
  },
  {
    id: 'entertainment',
    label: 'ENTERTAINMENT',
    query:
      '("box office" OR streaming OR Hollywood OR Netflix OR "film festival" OR ' +
      '"music album" OR concert OR Spotify OR "video game" OR Oscars OR Grammys OR ' +
      '"TV series" OR "film premiere" OR celebrity OR "movie release" OR ' +
      '"song release" OR "music video" OR "Emmy Awards" OR "Cannes Film" OR ' +
      '"album release" OR "world tour" OR "film studio") sourcelang:eng',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const GDELT_BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';
const FETCH_TIMEOUT_MS = 20_000;
const PACE_MS = 5_500;
const BUDGET_MS = 55_000;

const ACCUMULATOR_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ACCUMULATOR_TTL_S = 7 * 24 * 60 * 60;
const ACCUMULATOR_MAX_ITEMS = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Types — match server/intel-news/v1/list-headlines.ts wire shape so the
//        accumulator reads/writes are interoperable with the read endpoint.
// ─────────────────────────────────────────────────────────────────────────────

interface IntelNewsItem {
  source: string;
  title: string;
  link: string;
  publishedAt: number;
  isAlert: boolean;
  topic: string;
  tone: number | null;
  sources?: Array<{ source: string; title: string; link: string; publishedAt: number }>;
}

interface GdeltArticle {
  url?: string;
  url_mobile?: string;
  title?: string;
  seendate?: string;
  domain?: string;
  tone?: string | number;
}

interface GdeltResponse {
  articles?: GdeltArticle[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Upstash Redis REST helpers — inline to avoid the import-extension chain
// ─────────────────────────────────────────────────────────────────────────────

function getRedisCreds(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

async function redisGet<T>(key: string): Promise<T | null> {
  const creds = getRedisCreds();
  if (!creds) return null;
  try {
    const resp = await fetch(`${creds.url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${creds.token}` },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { result: string | null };
    if (!data.result) return null;
    try { return JSON.parse(data.result) as T; } catch { return null; }
  } catch {
    return null;
  }
}

async function redisSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const creds = getRedisCreds();
  if (!creds) return;
  try {
    const resp = await fetch(`${creds.url}/set/${encodeURIComponent(key)}?EX=${ttlSeconds}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(value),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.warn(`[intel-news:refresh] redis SET failed for "${key}":`, body.slice(0, 150));
    }
  } catch (err) {
    console.warn(`[intel-news:refresh] redis SET threw for "${key}":`, (err as Error).message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GDELT fetch + parse
// ─────────────────────────────────────────────────────────────────────────────

function parseGdeltDate(s: string | undefined): number {
  if (!s || s.length < 14) return 0;
  const yr = s.slice(0, 4);
  const mo = s.slice(4, 6);
  const dy = s.slice(6, 8);
  const hh = s.slice(9, 11);
  const mm = s.slice(11, 13);
  const ss = s.slice(13, 15);
  const t = Date.parse(`${yr}-${mo}-${dy}T${hh}:${mm}:${ss}Z`);
  return Number.isFinite(t) ? t : 0;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

async function fetchTopicArticles(topic: IntelTopic): Promise<IntelNewsItem[] | null> {
  const url = new URL(GDELT_BASE);
  url.searchParams.set('query', topic.query);
  url.searchParams.set('mode', 'artlist');
  url.searchParams.set('maxrecords', '30');
  url.searchParams.set('format', 'json');
  url.searchParams.set('sort', 'date');
  url.searchParams.set('timespan', '24h');

  const startMs = Date.now();
  console.log(
    `[intel-news:refresh] ${topic.id} GDELT GET maxrecords=30 timespan=24h ` +
    `timeout=${FETCH_TIMEOUT_MS}ms queryLen=${topic.query.length}`,
  );

  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; WorldMonitor/1.0)',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const elapsedMs = Date.now() - startMs;
    const e = err as Error;
    const isTimeout = e?.name === 'TimeoutError' || /abort|timeout/i.test(e?.message ?? '');
    const reason = isTimeout
      ? `TIMEOUT after ${elapsedMs}ms (limit=${FETCH_TIMEOUT_MS}ms)`
      : `NETWORK ERROR after ${elapsedMs}ms — ${e?.name ?? 'Error'}: ${e?.message ?? 'unknown'}`;
    console.warn(`[intel-news:refresh] ${topic.id} FAIL: ${reason}`);
    return null;
  }

  const elapsedMs = Date.now() - startMs;

  if (!resp.ok) {
    let bodyPreview = '';
    try { bodyPreview = (await resp.text()).slice(0, 200).replace(/\s+/g, ' ').trim(); } catch { /* ignore */ }
    const kind =
      resp.status === 429 ? 'RATE LIMITED (429)'
      : resp.status === 503 ? 'SERVICE UNAVAILABLE (503)'
      : resp.status >= 500 ? `UPSTREAM ERROR (${resp.status})`
      : `CLIENT ERROR (${resp.status})`;
    console.warn(`[intel-news:refresh] ${topic.id} FAIL: ${kind} after ${elapsedMs}ms · body="${bodyPreview || '<empty>'}"`);
    return null;
  }

  let data: GdeltResponse;
  let bodySize = 0;
  try {
    const bodyText = await resp.text();
    bodySize = bodyText.length;
    data = JSON.parse(bodyText) as GdeltResponse;
  } catch (err) {
    console.warn(`[intel-news:refresh] ${topic.id} FAIL: PARSE ERROR after ${elapsedMs}ms · bodySize=${bodySize} · ${(err as Error).message}`);
    return null;
  }

  const articles = Array.isArray(data?.articles) ? data.articles : [];
  if (articles.length === 0) {
    console.warn(`[intel-news:refresh] ${topic.id} EMPTY: 0 articles after ${elapsedMs}ms · bodySize=${bodySize}B`);
    return null;
  }

  // Build raw items, then dedup by normalized title (collapses syndicated wires).
  const rawItems: IntelNewsItem[] = [];
  for (const art of articles) {
    const link = String(art.url || art.url_mobile || '').trim();
    const title = String(art.title || '').trim();
    if (!link || !title) continue;
    rawItems.push({
      source: String(art.domain || 'GDELT').trim(),
      title,
      link,
      publishedAt: parseGdeltDate(art.seendate),
      isAlert: false,
      topic: topic.id,
      tone: toNumber(art.tone),
    });
  }

  if (rawItems.length === 0) return null;

  const groups = new Map<string, IntelNewsItem[]>();
  for (const item of rawItems) {
    const k = normalizeTitle(item.title);
    if (!k) continue;
    const bucket = groups.get(k) ?? [];
    bucket.push(item);
    groups.set(k, bucket);
  }

  const items: IntelNewsItem[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => b.publishedAt - a.publishedAt);
    const canonical = group[0]!;
    if (group.length > 1) {
      canonical.sources = group.map((g) => ({
        source: g.source, title: g.title, link: g.link, publishedAt: g.publishedAt,
      }));
    }
    items.push(canonical);
  }
  items.sort((a, b) => b.publishedAt - a.publishedAt);

  console.log(
    `[intel-news:refresh] ${topic.id} OK: ${items.length} items in ${elapsedMs}ms · ` +
    `bodySize=${(bodySize / 1024).toFixed(1)}KB`,
  );
  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// Accumulator merge
// ─────────────────────────────────────────────────────────────────────────────

async function mergeIntoAccumulator(topicId: string, freshItems: IntelNewsItem[]): Promise<number> {
  const key = `intel-news:topic:v6:${topicId}:accumulator`;
  const cutoff = Date.now() - ACCUMULATOR_RETENTION_MS;

  const existing = await redisGet<IntelNewsItem[]>(key);
  const byLink = new Map<string, IntelNewsItem>();

  if (Array.isArray(existing)) {
    for (const item of existing) {
      if (item && typeof item.link === 'string' && item.link) byLink.set(item.link, item);
    }
  }
  for (const item of freshItems) {
    if (item && typeof item.link === 'string' && item.link) byLink.set(item.link, item);
  }

  const merged = [...byLink.values()]
    .filter((it) => typeof it.publishedAt === 'number' && it.publishedAt >= cutoff)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, ACCUMULATOR_MAX_ITEMS);

  await redisSet(key, merged, ACCUMULATOR_TTL_S);
  return merged.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main refresh loop
// ─────────────────────────────────────────────────────────────────────────────

interface RefreshResult {
  succeeded: number;
  failed: number;
  skipped: number;
  durationMs: number;
  perTopic: Array<{
    id: string;
    outcome: 'success' | 'failed' | 'skipped';
    items?: number;
    accumulatorSize?: number;
    elapsedMs?: number;
  }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function refreshAllTopics(): Promise<RefreshResult> {
  const runStartMs = Date.now();
  const result: RefreshResult = { succeeded: 0, failed: 0, skipped: 0, durationMs: 0, perTopic: [] };
  let lastRequestStartMs = 0;

  for (const topic of INTEL_TOPICS) {
    const elapsedSinceStart = Date.now() - runStartMs;

    // Budget gate — skip if not enough time for a worst-case 10s GDELT call.
    if (elapsedSinceStart > BUDGET_MS - 10_000) {
      console.log(`[intel-news:refresh] budget exhausted at ${elapsedSinceStart}ms, skipping ${topic.id}`);
      result.skipped++;
      result.perTopic.push({ id: topic.id, outcome: 'skipped' });
      continue;
    }

    // Pacing gate — strict 5.5s between consecutive GDELT calls.
    if (lastRequestStartMs > 0) {
      const sinceLast = Date.now() - lastRequestStartMs;
      if (sinceLast < PACE_MS) await sleep(PACE_MS - sinceLast);
    }

    lastRequestStartMs = Date.now();
    const fetchStart = Date.now();

    try {
      const fresh = await fetchTopicArticles(topic);
      const fetchMs = Date.now() - fetchStart;

      if (fresh) {
        const accumulatorSize = await mergeIntoAccumulator(topic.id, fresh);
        result.succeeded++;
        result.perTopic.push({
          id: topic.id,
          outcome: 'success',
          items: fresh.length,
          accumulatorSize,
          elapsedMs: fetchMs,
        });
        console.log(`[intel-news:refresh] ${topic.id}: ${fresh.length} fresh → ${accumulatorSize} in accumulator ✓`);
      } else {
        result.failed++;
        result.perTopic.push({ id: topic.id, outcome: 'failed', elapsedMs: fetchMs });
      }
    } catch (err) {
      const fetchMs = Date.now() - fetchStart;
      result.failed++;
      result.perTopic.push({ id: topic.id, outcome: 'failed', elapsedMs: fetchMs });
      console.warn(`[intel-news:refresh] ${topic.id}: threw after ${fetchMs}ms — ${(err as Error).message}`);
    }
  }

  result.durationMs = Date.now() - runStartMs;
  console.log(
    `[intel-news:refresh] done in ${result.durationMs}ms · ` +
    `${result.succeeded} ok, ${result.failed} failed, ${result.skipped} skipped`,
  );
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth + handler
// ─────────────────────────────────────────────────────────────────────────────

function isAuthorizedCron(req: IncomingMessage): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = (req.headers.authorization ?? '') as string;
    if (auth === `Bearer ${secret}`) return true;
  }
  const ua = ((req.headers['user-agent'] ?? '') as string).toLowerCase();
  if (ua.includes('vercel-cron')) return true;
  return false;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  if (!isAuthorizedCron(req)) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Forbidden — cron-only endpoint' }));
    return;
  }

  try {
    const result = await refreshAllTopics();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error('[intel-news:refresh] handler failed:', err instanceof Error ? err.message : err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Internal error' }));
  }
}
