/**
 * `GET /api/intel-news/v1/enrich` — AI-summary enrichment for intel-news items.
 *
 * Reads each topic's accumulator, finds items where `summary` is absent,
 * fetches the article body (best-effort), and runs a 1–3 paragraph
 * summarization prompt through Gemini Flash (Claude Haiku as fallback).
 * Summaries are persisted back into the accumulator so subsequent
 * refresh + enrich cycles never re-summarize the same article.
 *
 * # Triggering
 *
 * Called automatically by `refresh.ts` at the end of each steady-state
 * cron firing (skipped on `?backfill=N` runs). Also reachable directly
 * with the cron secret for manual catch-up runs after a backfill, or to
 * retry items whose previous enrichment failed.
 *
 * Idempotent — items that already have `summary` are skipped. Failed
 * enrichments leave `summary` unset so the next run picks them up.
 *
 * # Self-contained
 *
 * Same "no relative imports" pattern as refresh.ts to avoid the
 * Node-ESM module-resolution issues we hit on the cron path. Redis,
 * LLM calls, HTML→text extraction are all inlined.
 */

import type { IncomingMessage, ServerResponse } from 'http';

export const config = {
  // Pro-plan ceiling. Cron normally only fires ~150 enrichments per call
  // (one batch's newly-added items); 280 s of budget gives concurrency-5
  // workers plenty of room to finish them. Manual catch-up runs after a
  // backfill (~14k items) need many calls to drain the queue.
  maxDuration: 300,
};

// ─────────────────────────────────────────────────────────────────────────────
// Topics — must match refresh.ts so accumulator keys line up.
// ─────────────────────────────────────────────────────────────────────────────

const TOPIC_IDS = [
  'conflict', 'cyber', 'military', 'nuclear', 'sanctions', 'intelligence',
  'maritime', 'business', 'scitech', 'entertainment',
] as const;

const accumulatorKey = (id: string): string => `intel-news:topic:v6:${id}:accumulator`;

const ACCUMULATOR_TTL_S = 7 * 24 * 60 * 60;

// ─────────────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────────────

const ARTICLE_FETCH_TIMEOUT_MS = 5_000;
const LLM_TIMEOUT_MS = 20_000;
// Concurrency picked to roughly maximize throughput without overloading
// downstream rate limits:
//   • Gemini Flash Lite paid tier: thousands of requests/min — at 20
//     concurrent × ~3-4 s avg = ~5-7 RPS = ~350 RPM, still well below limit
//   • Article fetches: spread across many distinct domains, so per-domain
//     rate limits don't apply at this scale
//   • Vercel function memory: 20 in-flight × ~10 KB = ~200 KB — negligible
//     against the 1.7 GB ceiling
// At 20 we can drain ~1 400 items per run; the initial 2 800-item backlog
// clears in ~2 runs (~30 min) instead of ~10 runs (~2.5 h) at the original 5.
const CONCURRENCY = 40;

// Soft ceiling — leaves ~20 s for the final Redis writes and JSON response
// under the 300 s `maxDuration`. Past this point new tasks are skipped
// (left in the accumulator for the next enrich pass).
const BUDGET_MS = 280_000;

const ARTICLE_BODY_MAX_CHARS = 5_000;
const SUMMARY_MIN_LEN = 30;
const SUMMARY_MAX_LEN = 2_500;

// ─────────────────────────────────────────────────────────────────────────────
// Wire shape — must match refresh.ts / list-headlines.ts.
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
  summary?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Upstash Redis REST helpers
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
      console.warn(`[intel-news:enrich] redis SET failed for "${key}":`, body.slice(0, 150));
    }
  } catch (err) {
    console.warn(`[intel-news:enrich] redis SET threw for "${key}":`, (err as Error).message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML → plain text — minimal regex extractor. Good enough for sending to
// an LLM for summarization (we just need readable prose to feed into the
// prompt). Not a full Readability port — that would be 1500+ lines.
// ─────────────────────────────────────────────────────────────────────────────

function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchArticleBody(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WorldMonitorBot/1.0; +https://worldmonitor.news)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(ARTICLE_FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!resp.ok) return null;
    const ct = resp.headers.get('content-type') ?? '';
    if (!ct.toLowerCase().includes('html')) return null;
    const html = await resp.text();
    const text = htmlToText(html);
    if (text.length < 100) return null;
    return text.slice(0, ARTICLE_BODY_MAX_CHARS);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM calls — Gemini Flash primary, Claude Haiku fallback. Inlined to keep
// this file self-contained per the cron-isolation rule. Same env vars and
// behavior as `server/_shared/llm.ts` for parity.
// ─────────────────────────────────────────────────────────────────────────────

async function callGemini(system: string, prompt: string): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const model = 'gemini-2.5-flash-lite';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        system_instruction: { parts: [{ text: system }] },
        generationConfig: { temperature: 0.3, maxOutputTokens: 800 },
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '').join('').trim();
    return text || null;
  } catch {
    return null;
  }
}

async function callClaude(system: string, prompt: string): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 800,
        temperature: 0.3,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { content?: Array<{ type?: string; text?: string }> };
    const text = (data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '').join('').trim();
    return text || null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-item enrichment
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  'You are summarizing a news article for a world events tracking app. ' +
  'Write a neutral, factual summary in 1–3 short paragraphs that captures ' +
  'the key points: who, what, when, where, why. Match the tone of major ' +
  'newswires (Reuters, AP, BBC). Avoid editorializing, speculation, or ' +
  'opinion. Do not repeat the headline verbatim. Use plain prose only — ' +
  'no bullet points, no markdown, no headers. Aim for 80–250 words. ' +
  'If the source content is paywalled, garbled, or unrelated to the headline, ' +
  'write a 2–3 sentence neutral overview based on the headline alone.';

function buildPrompt(item: IntelNewsItem, body: string | null): string {
  const header = `Headline: ${item.title}\nSource: ${item.source}\n`;
  if (body) {
    return `${header}\nArticle text:\n${body}`;
  }
  return `${header}\n(Article body unavailable — write a brief 2–3 sentence neutral overview of what this story is most likely about, based on the headline.)`;
}

function isValidSummary(s: string | null): s is string {
  if (!s) return false;
  const trimmed = s.trim();
  if (trimmed.length < SUMMARY_MIN_LEN || trimmed.length > SUMMARY_MAX_LEN) return false;
  // Reject obvious refusals / boilerplate.
  if (/^(I cannot|I can't|I'm sorry|I apologize|As an AI)/i.test(trimmed)) return false;
  return true;
}

async function enrichItem(item: IntelNewsItem): Promise<string | null> {
  const body = await fetchArticleBody(item.link);
  const prompt = buildPrompt(item, body);

  let summary = await callGemini(SYSTEM_PROMPT, prompt);
  if (!isValidSummary(summary)) {
    summary = await callClaude(SYSTEM_PROMPT, prompt);
    if (!isValidSummary(summary)) return null;
  }
  return summary.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Main enrichment loop — concurrency-N worker pool over a global queue
// ─────────────────────────────────────────────────────────────────────────────

interface PerTopicStats {
  toEnrich: number;
  succeeded: number;
  failed: number;
  bodyFetched: number;
}

interface EnrichResult {
  durationMs: number;
  totals: {
    topics: number;
    queued: number;
    succeeded: number;
    failed: number;
    skippedBudget: number;
  };
  perTopic: Record<string, PerTopicStats>;
}

async function runEnrichment(): Promise<EnrichResult> {
  const start = Date.now();

  // Load all 10 accumulators in parallel.
  const topicData: Record<string, IntelNewsItem[]> = {};
  await Promise.all(TOPIC_IDS.map(async (tid) => {
    const items = await redisGet<IntelNewsItem[]>(accumulatorKey(tid));
    topicData[tid] = Array.isArray(items) ? items : [];
  }));

  // Build a flat queue of items to enrich. Tuple (topicId, index in array)
  // so we can mutate the original array when the LLM returns.
  //
  // Queue ordering is ROUND-ROBIN across topics, not topic-by-topic. With
  // a single 280 s budget per run and a backlog of ~2 800 items at first
  // sync, a topic-sequential queue would spend the entire run inside the
  // first topic (e.g. all 389 conflict items consume the whole budget,
  // leaving 9 topics with 0 progress). Users would see chips fill in one
  // at a time over many runs. Round-robin guarantees every topic makes
  // proportional progress on every run.
  interface QueueEntry { topicId: string; idx: number; }
  const queue: QueueEntry[] = [];
  const perTopic: Record<string, PerTopicStats> = {};

  // Per-topic lists of indices that need enrichment, in original order.
  const perTopicQueues: Array<{ topicId: string; indices: number[] }> = [];
  for (const tid of TOPIC_IDS) {
    perTopic[tid] = { toEnrich: 0, succeeded: 0, failed: 0, bodyFetched: 0 };
    const items = topicData[tid] ?? [];
    const indices: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;
      if (!item.summary) indices.push(i);
    }
    perTopic[tid].toEnrich = indices.length;
    if (indices.length > 0) perTopicQueues.push({ topicId: tid, indices });
  }

  // Interleave: take one from each non-empty topic in turn until all are
  // drained. Order within a topic is preserved (newest items first since
  // accumulators are sorted by publishedAt desc), so the most recent
  // unsummarized item from each topic is always processed first.
  let cursor2 = 0;
  while (perTopicQueues.some((q) => cursor2 < q.indices.length)) {
    for (const q of perTopicQueues) {
      if (cursor2 < q.indices.length) {
        const idx = q.indices[cursor2];
        if (idx !== undefined) queue.push({ topicId: q.topicId, idx });
      }
    }
    cursor2++;
  }

  const queued = queue.length;
  console.log(
    `[intel-news:enrich] ${queued} items to enrich across ${TOPIC_IDS.length} topics ` +
    `(concurrency=${CONCURRENCY}, budget=${BUDGET_MS}ms)`,
  );

  let cursor = 0;
  let succeeded = 0;
  let failed = 0;
  let skippedBudget = 0;

  async function runner(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= queue.length) return;
      if (Date.now() - start > BUDGET_MS) {
        skippedBudget++;
        continue;
      }
      const entry = queue[idx];
      if (!entry) continue;
      const items = topicData[entry.topicId];
      if (!items) continue;
      const item = items[entry.idx];
      if (!item) continue;

      try {
        const summary = await enrichItem(item);
        if (summary) {
          item.summary = summary;
          succeeded++;
          const stats = perTopic[entry.topicId];
          if (stats) stats.succeeded++;
        } else {
          failed++;
          const stats = perTopic[entry.topicId];
          if (stats) stats.failed++;
        }
      } catch (err) {
        failed++;
        const stats = perTopic[entry.topicId];
        if (stats) stats.failed++;
        console.warn(`[intel-news:enrich] item threw: ${(err as Error).message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => runner()));

  // Write back each accumulator that gained at least one summary. (We don't
  // need to write back if nothing changed — saves Redis traffic.)
  await Promise.all(TOPIC_IDS.map(async (tid) => {
    const stats = perTopic[tid];
    if (!stats || stats.succeeded === 0) return;
    const items = topicData[tid];
    if (!items) return;
    await redisSet(accumulatorKey(tid), items, ACCUMULATOR_TTL_S);
  }));

  const durationMs = Date.now() - start;

  // Per-topic log summary, only for topics that did anything.
  for (const tid of TOPIC_IDS) {
    const s = perTopic[tid];
    if (!s || s.toEnrich === 0) continue;
    console.log(
      `[intel-news:enrich] ${tid}: queued=${s.toEnrich} ✓${s.succeeded} ✗${s.failed}`,
    );
  }
  console.log(
    `[intel-news:enrich] done in ${durationMs}ms · ` +
    `${succeeded} succeeded, ${failed} failed, ${skippedBudget} budget-skipped of ${queued}`,
  );

  return {
    durationMs,
    totals: { topics: TOPIC_IDS.length, queued, succeeded, failed, skippedBudget },
    perTopic,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth + handler
// ─────────────────────────────────────────────────────────────────────────────

function isAuthorized(req: IncomingMessage): boolean {
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

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  if (!isAuthorized(req)) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Forbidden — cron-only endpoint' }));
    return;
  }

  try {
    const result = await runEnrichment();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error('[intel-news:enrich] handler failed:', err instanceof Error ? err.message : err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Internal error' }));
  }
}
