// Phase 3b: LLM enrichment for the WorldMonitor Brief envelope.
//
// Substitutes the stubbed `whyMatters` per story and the stubbed
// executive summary (`digest.lead` / `digest.threads` / `digest.signals`)
// with Gemini 2.5 Flash output via the existing OpenRouter-backed
// callLLM chain. The LLM provider is pinned to openrouter by
// skipProviders:['ollama','groq'] so the brief's editorial voice
// stays on one model across environments.
//
// Deliberately:
//   - Pure parse/build helpers are exported for testing without IO.
//   - Cache layer is parameterised (cacheGet / cacheSet) so tests use
//     an in-memory stub and production uses Upstash.
//   - Any failure (null LLM result, parse error, cache hiccup) falls
//     through to the original stub — the brief must always ship.
//
// Cache semantics:
//   - brief:llm:whymatters:v1:{storyHash}   — 24h, shared across users.
//     whyMatters is editorial global-stakes commentary, not user
//     personalisation, so per-story caching collapses N×U LLM calls
//     to N.
//   - brief:llm:digest:v1:{userId}:{poolHash} — 4h, per user.
//     The executive summary IS personalised to a user's sensitivity
//     and surfaced story pool, so cache keys include a hash of both.
//     4h balances cost vs freshness — hourly cron pays at most once
//     per 4 ticks per user.

import { createHash } from 'node:crypto';

// ── Tunables ───────────────────────────────────────────────────────────────

const WHY_MATTERS_TTL_SEC = 24 * 60 * 60;
const DIGEST_PROSE_TTL_SEC = 4 * 60 * 60;
const WHY_MATTERS_CONCURRENCY = 5;

// Pin to openrouter (google/gemini-2.5-flash). Ollama isn't deployed
// in Railway and groq (llama-3.1-8b) produces noticeably less
// editorial prose than Gemini Flash.
const BRIEF_LLM_SKIP_PROVIDERS = ['ollama', 'groq'];

// ── whyMatters (per story) ─────────────────────────────────────────────────

const WHY_MATTERS_SYSTEM =
  'You are the editor of WorldMonitor Brief, a geopolitical intelligence magazine. ' +
  'For each story below, write ONE concise sentence (18–30 words) explaining the ' +
  'regional or global stakes. Editorial, impersonal, serious. No preamble ' +
  '("This matters because…"), no questions, no calls to action, no markdown, ' +
  'no quotes. One sentence only.';

/**
 * Deterministic hash of the story identity used as cache key.
 * Same headline + source + severity from two users gets one LLM call.
 * @param {{ headline: string; source: string; threatLevel: string }} story
 */
function hashStory(story) {
  const material = `${story.headline}||${story.source}||${story.threatLevel}`;
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/**
 * @param {{ headline: string; source: string; threatLevel: string; category: string; country: string }} story
 * @returns {{ system: string; user: string }}
 */
export function buildWhyMattersPrompt(story) {
  const user = [
    `Headline: ${story.headline}`,
    `Source: ${story.source}`,
    `Severity: ${story.threatLevel}`,
    `Category: ${story.category}`,
    `Country: ${story.country}`,
    '',
    'One editorial sentence on why this matters:',
  ].join('\n');
  return { system: WHY_MATTERS_SYSTEM, user };
}

/**
 * Parse + validate the LLM response into a single editorial sentence.
 * Returns null when the output is obviously wrong (empty, boilerplate
 * preamble that survived stripReasoningPreamble, too short / too long).
 *
 * @param {unknown} text
 * @returns {string | null}
 */
export function parseWhyMatters(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  if (!s) return null;
  // Drop surrounding quotes if the model insisted.
  s = s.replace(/^[\u201C"']+/, '').replace(/[\u201D"']+$/, '').trim();
  // Take the first sentence only. Keep terminal punctuation.
  const match = s.match(/^[^.!?]+[.!?]/);
  const sentence = match ? match[0].trim() : s;
  if (sentence.length < 30 || sentence.length > 400) return null;
  // Reject the stub itself — if the LLM echoed it back verbatim we
  // don't want to cache that as "enrichment".
  if (/^story flagged by your sensitivity/i.test(sentence)) return null;
  return sentence;
}

/**
 * Resolve a `whyMatters` sentence for one story via cache → LLM.
 * Returns null on any failure; caller falls back to the stub.
 *
 * @param {object} story
 * @param {{
 *   callLLM: (system: string, user: string, opts: object) => Promise<string|null>;
 *   cacheGet: (key: string) => Promise<unknown>;
 *   cacheSet: (key: string, value: unknown, ttlSec: number) => Promise<void>;
 * }} deps
 */
export async function generateWhyMatters(story, deps) {
  const key = `brief:llm:whymatters:v1:${hashStory(story)}`;
  try {
    const hit = await deps.cacheGet(key);
    if (typeof hit === 'string' && hit.length > 0) return hit;
  } catch { /* cache miss is fine */ }
  const { system, user } = buildWhyMattersPrompt(story);
  let text = null;
  try {
    text = await deps.callLLM(system, user, {
      maxTokens: 120,
      temperature: 0.4,
      timeoutMs: 10_000,
      skipProviders: BRIEF_LLM_SKIP_PROVIDERS,
    });
  } catch {
    return null;
  }
  const parsed = parseWhyMatters(text);
  if (!parsed) return null;
  try {
    await deps.cacheSet(key, parsed, WHY_MATTERS_TTL_SEC);
  } catch { /* cache write failures don't matter here */ }
  return parsed;
}

// ── Digest prose (per user) ────────────────────────────────────────────────

const DIGEST_PROSE_SYSTEM =
  'You are the chief editor of WorldMonitor Brief. Given a ranked list of ' +
  "today's top stories for a reader, produce EXACTLY this JSON and nothing " +
  'else (no markdown, no code fences, no preamble):\n' +
  '{\n' +
  '  "lead": "<2–3 sentence executive summary, editorial tone, references ' +
  'the most important 1–2 threads, addresses the reader in the third person>",\n' +
  '  "threads": [\n' +
  '    { "tag": "<one-word editorial category e.g. Energy, Diplomacy, Climate>", ' +
  '"teaser": "<one sentence describing what is developing>" }\n' +
  '  ],\n' +
  '  "signals": ["<forward-looking imperative phrase, <=14 words>"]\n' +
  '}\n' +
  'Threads: 3–6 items reflecting actual clusters in the stories. ' +
  'Signals: 2–4 items, forward-looking.';

/**
 * @param {Array<{ headline: string; threatLevel: string; category: string; country: string; source: string }>} stories
 * @param {string} sensitivity
 * @returns {{ system: string; user: string }}
 */
export function buildDigestPrompt(stories, sensitivity) {
  const lines = stories.slice(0, 12).map((s, i) => {
    const n = String(i + 1).padStart(2, '0');
    return `${n}. [${s.threatLevel}] ${s.headline} — ${s.category} · ${s.country} · ${s.source}`;
  });
  const user = [
    `Reader sensitivity level: ${sensitivity}`,
    '',
    "Today's surfaced stories (ranked):",
    ...lines,
  ].join('\n');
  return { system: DIGEST_PROSE_SYSTEM, user };
}

/**
 * @param {unknown} text
 * @returns {{ lead: string; threads: Array<{tag:string;teaser:string}>; signals: string[] } | null}
 */
export function parseDigestProse(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  if (!s) return null;
  // Defensive: strip common wrappings the model sometimes inserts
  // despite the explicit system instruction.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let obj;
  try {
    obj = JSON.parse(s);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const lead = typeof obj.lead === 'string' ? obj.lead.trim() : '';
  if (lead.length < 40 || lead.length > 800) return null;

  const rawThreads = Array.isArray(obj.threads) ? obj.threads : [];
  const threads = rawThreads
    .filter((t) => t && typeof t.tag === 'string' && typeof t.teaser === 'string')
    .map((t) => ({
      tag: t.tag.trim().slice(0, 40),
      teaser: t.teaser.trim().slice(0, 220),
    }))
    .filter((t) => t.tag.length > 0 && t.teaser.length > 0)
    .slice(0, 6);
  if (threads.length < 1) return null;

  const rawSignals = Array.isArray(obj.signals) ? obj.signals : [];
  const signals = rawSignals
    .filter((x) => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length > 0 && x.length < 220)
    .slice(0, 6);

  return { lead, threads, signals };
}

/**
 * Cache key for digest prose — scoped to (userId, sensitivity) and to
 * the actual story pool, so an LLM call is re-used only when the pool
 * has not changed. Pool hash intentionally uses headline + severity
 * only; re-ordering by score between runs must re-use the same prose.
 */
function hashDigestInput(userId, stories, sensitivity) {
  const material = stories
    .map((s) => `${s.headline}|${s.threatLevel}`)
    .sort()
    .join('\n') + `|${sensitivity}`;
  const h = createHash('sha256').update(material).digest('hex').slice(0, 16);
  return `${userId}:${sensitivity}:${h}`;
}

/**
 * Resolve the digest prose object via cache → LLM.
 * @param {string} userId
 * @param {Array} stories
 * @param {string} sensitivity
 * @param {object} deps — { callLLM, cacheGet, cacheSet }
 */
export async function generateDigestProse(userId, stories, sensitivity, deps) {
  const key = `brief:llm:digest:v1:${hashDigestInput(userId, stories, sensitivity)}`;
  try {
    const hit = await deps.cacheGet(key);
    if (hit && typeof hit === 'object' && typeof hit.lead === 'string') return hit;
  } catch { /* cache miss fine */ }
  const { system, user } = buildDigestPrompt(stories, sensitivity);
  let text = null;
  try {
    text = await deps.callLLM(system, user, {
      maxTokens: 700,
      temperature: 0.4,
      timeoutMs: 15_000,
      skipProviders: BRIEF_LLM_SKIP_PROVIDERS,
    });
  } catch {
    return null;
  }
  const parsed = parseDigestProse(text);
  if (!parsed) return null;
  try {
    await deps.cacheSet(key, parsed, DIGEST_PROSE_TTL_SEC);
  } catch { /* ignore */ }
  return parsed;
}

// ── Envelope enrichment ────────────────────────────────────────────────────

/**
 * Bounded-concurrency map. Preserves input order. Doesn't short-circuit
 * on individual failures — fn is expected to return a sentinel (null)
 * on error and the caller decides.
 */
async function mapLimit(items, limit, fn) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const n = Math.min(Math.max(1, limit), items.length);
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch {
        out[idx] = items[idx];
      }
    }
  }
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

/**
 * Take a baseline BriefEnvelope (stubbed whyMatters + stubbed lead /
 * threads / signals) and enrich it with LLM output. All failures fall
 * through cleanly — the envelope that comes out is always a valid
 * BriefEnvelope (structure unchanged; only string/array field
 * contents are substituted).
 *
 * @param {object} envelope
 * @param {{ userId: string; sensitivity?: string }} rule
 * @param {{ callLLM: Function; cacheGet: Function; cacheSet: Function }} deps
 */
export async function enrichBriefEnvelopeWithLLM(envelope, rule, deps) {
  if (!envelope?.data || !Array.isArray(envelope.data.stories)) return envelope;
  const stories = envelope.data.stories;
  const sensitivity = rule?.sensitivity ?? 'all';

  // Per-story whyMatters — parallel but bounded.
  const enrichedStories = await mapLimit(stories, WHY_MATTERS_CONCURRENCY, async (story) => {
    const why = await generateWhyMatters(story, deps);
    if (!why) return story;
    return { ...story, whyMatters: why };
  });

  // Per-user digest prose — one call.
  const prose = await generateDigestProse(rule.userId, stories, sensitivity, deps);
  const digest = prose
    ? {
        ...envelope.data.digest,
        lead: prose.lead,
        threads: prose.threads,
        signals: prose.signals,
      }
    : envelope.data.digest;

  return {
    ...envelope,
    data: {
      ...envelope.data,
      digest,
      stories: enrichedStories,
    },
  };
}
