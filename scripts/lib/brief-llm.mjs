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
//   - brief:llm:whymatters:v3:{storyHash}:{leadHash} — 24h, shared
//     across users for the same (story, lead) pair. v3 includes
//     SHA-256 of the resolved digest lead so per-story rationales
//     re-generate when the lead changes (rationales must align with
//     the headline frame). v2 rows were lead-blind and could drift.
//   - brief:llm:digest:v4:{userId|public}:{sensitivity}:{poolHash}
//     — 4h. The canonical synthesis is now ALWAYS produced through
//     this path (formerly split with `generateAISummary` in the
//     digest cron). Material includes profile-SHA, greeting bucket,
//     isPublic flag, and per-story hash so cache hits never serve a
//     differently-ranked or differently-personalised prompt.
//     When isPublic=true, the userId slot in the key is the literal
//     string 'public' so all public-share readers of the same
//     (date, sensitivity, story-pool) hit the same row — no PII in
//     the public cache key. v2 rows ignored on rollout.

import { createHash } from 'node:crypto';

import {
  WHY_MATTERS_SYSTEM,
  buildWhyMattersUserPrompt,
  hashBriefStory,
  parseWhyMatters,
} from '../../shared/brief-llm-core.js';
import { sanitizeForPrompt } from '../../server/_shared/llm-sanitize.js';
// Single source of truth for the brief story cap. Both buildDigestPrompt
// and hashDigestInput must slice to this value or the LLM prose drifts
// from the rendered story cards (PR #3389 reviewer P1).
import { MAX_STORIES_PER_USER } from './brief-compose.mjs';

/**
 * Sanitize the story fields that flow into buildWhyMattersUserPrompt and
 * buildStoryDescriptionPrompt. Mirrors
 * server/worldmonitor/intelligence/v1/brief-why-matters-prompt.ts
 * sanitizeStoryFields — the legacy Railway fallback path must apply the
 * same defense as the analyst endpoint, since this is exactly what runs
 * when the endpoint misses / returns null / throws.
 *
 * `description` is included because the RSS-description fix (2026-04-24)
 * now threads untrusted article bodies into the description prompt as
 * grounding context. Without sanitising it, a hostile feed's
 * `<description>` is an unsanitised injection vector — the asymmetry with
 * whyMatters (already sanitised) was a latent bug, fixed here.
 *
 * Kept local (not promoted to brief-llm-core.js) because llm-sanitize.js
 * only lives in server/_shared and the edge endpoint already sanitizes
 * before its own buildWhyMattersUserPrompt call.
 *
 * @param {{ headline?: string; source?: string; threatLevel?: string; category?: string; country?: string; description?: string }} story
 */
function sanitizeStoryForPrompt(story) {
  return {
    headline: sanitizeForPrompt(story.headline ?? ''),
    source: sanitizeForPrompt(story.source ?? ''),
    threatLevel: sanitizeForPrompt(story.threatLevel ?? ''),
    category: sanitizeForPrompt(story.category ?? ''),
    country: sanitizeForPrompt(story.country ?? ''),
    description: sanitizeForPrompt(story.description ?? ''),
  };
}

// Re-export for backcompat with existing tests / callers.
export { WHY_MATTERS_SYSTEM, hashBriefStory, parseWhyMatters };
export const buildWhyMattersPrompt = buildWhyMattersUserPrompt;

// ── Tunables ───────────────────────────────────────────────────────────────

const WHY_MATTERS_TTL_SEC = 24 * 60 * 60;
const DIGEST_PROSE_TTL_SEC = 4 * 60 * 60;
const STORY_DESCRIPTION_TTL_SEC = 24 * 60 * 60;
const WHY_MATTERS_CONCURRENCY = 5;

// Pin to openrouter (google/gemini-2.5-flash). Ollama isn't deployed
// in Railway and groq (llama-3.1-8b) produces noticeably less
// editorial prose than Gemini Flash.
const BRIEF_LLM_SKIP_PROVIDERS = ['ollama', 'groq'];

// ── whyMatters (per story) ─────────────────────────────────────────────────
// The pure helpers (`WHY_MATTERS_SYSTEM`, `buildWhyMattersUserPrompt` (aliased
// to `buildWhyMattersPrompt` for backcompat), `parseWhyMatters`, `hashBriefStory`)
// live in `shared/brief-llm-core.js` so the Vercel-edge endpoint
// (`api/internal/brief-why-matters.ts`) can import them without pulling in
// `node:crypto`. See the `shared/` → `scripts/shared/` mirror convention.

/**
 * Resolve a `whyMatters` sentence for one story.
 *
 * Three-layer graceful degradation:
 *   1. `deps.callAnalystWhyMatters(story)` — the analyst-context edge
 *      endpoint (brief:llm:whymatters:v3 cache lives there). Preferred.
 *   2. Legacy direct-Gemini chain: cacheGet (v2) → callLLM → cacheSet.
 *      Runs whenever the analyst call is missing, returns null, or throws.
 *   3. Caller (enrichBriefEnvelopeWithLLM) uses the baseline stub if
 *      this function returns null.
 *
 * Returns null on all-layer failure.
 *
 * @param {object} story
 * @param {{
 *   callLLM: (system: string, user: string, opts: object) => Promise<string|null>;
 *   cacheGet: (key: string) => Promise<unknown>;
 *   cacheSet: (key: string, value: unknown, ttlSec: number) => Promise<void>;
 *   callAnalystWhyMatters?: (story: object) => Promise<string|null>;
 * }} deps
 */
export async function generateWhyMatters(story, deps) {
  // Priority path: analyst endpoint. It owns its own cache and has
  // ALREADY validated the output via parseWhyMatters (gemini path) or
  // parseWhyMattersV2 (analyst path, multi-sentence). We must NOT
  // re-parse here with the single-sentence v1 parser — that silently
  // truncates v2's 2–3-sentence output to the first sentence. Trust
  // the wire shape; only reject an obviously-bad payload (empty, stub
  // echo, or length outside the legal bounds for either parser).
  if (typeof deps.callAnalystWhyMatters === 'function') {
    try {
      const analystOut = await deps.callAnalystWhyMatters(story);
      if (typeof analystOut === 'string') {
        const trimmed = analystOut.trim();
        const lenOk = trimmed.length >= 30 && trimmed.length <= 500;
        const notStub = !/^story flagged by your sensitivity/i.test(trimmed);
        if (lenOk && notStub) return trimmed;
        console.warn(
          `[brief-llm] callAnalystWhyMatters → fallback: endpoint returned out-of-bounds or stub (len=${trimmed.length})`,
        );
      } else {
        console.warn('[brief-llm] callAnalystWhyMatters → fallback: null/empty response');
      }
    } catch (err) {
      console.warn(
        `[brief-llm] callAnalystWhyMatters → fallback: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Fallback path: legacy direct-Gemini chain with the v3 cache.
  // Bumped v2→v3 on 2026-04-24 alongside the RSS-description fix: rows
  // keyed on the prior v2 prefix were produced from headline-only prompts
  // and may reference hallucinated named actors. The prefix bump forces
  // a clean cold-start on first tick after deploy; entries expire in
  // ≤24h so the prior prefix ages out naturally without a DEL sweep.
  const key = `brief:llm:whymatters:v3:${await hashBriefStory(story)}`;
  try {
    const hit = await deps.cacheGet(key);
    if (typeof hit === 'string' && hit.length > 0) return hit;
  } catch { /* cache miss is fine */ }
  // Sanitize story fields before interpolating into the prompt. The analyst
  // endpoint already does this; without it the Railway fallback path was an
  // unsanitized injection vector for any future untrusted `source` / `headline`.
  const { system, user } = buildWhyMattersPrompt(sanitizeStoryForPrompt(story));
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

// ── Per-story description (replaces title-verbatim fallback) ──────────────

const STORY_DESCRIPTION_SYSTEM =
  'You are the editor of WorldMonitor Brief, a geopolitical intelligence magazine. ' +
  'Given the story attributes below, write ONE concise sentence (16–30 words) that ' +
  'describes the development itself — not why it matters, not the reader reaction. ' +
  'Editorial, serious, past/present tense, named actors where possible. Do NOT ' +
  'repeat the headline verbatim. No preamble, no quotes, no questions, no markdown, ' +
  'no hedging. One sentence only.';

/**
 * @param {{ headline: string; source: string; category: string; country: string; threatLevel: string; description?: string }} story
 * @returns {{ system: string; user: string }}
 */
export function buildStoryDescriptionPrompt(story) {
  // Grounding context: when the RSS feed carried a real description
  // (post-RSS-description fix, 2026-04-24), interpolate it as `Context:`
  // between the metadata block and the "One editorial sentence" instruction.
  // This is the actual fix for the named-actor hallucination class — the LLM
  // now has the article's body to paraphrase instead of filling role-label
  // headlines from its parametric priors. Skip when description is empty or
  // normalise-equal to the headline (no grounding value; parser already
  // filters this but the prompt builder is a second belt-and-braces check).
  const normalise = /** @param {string} x */ (x) => x.trim().toLowerCase().replace(/\s+/g, ' ');
  const rawDescription = typeof story.description === 'string' ? story.description.trim() : '';
  const contextUseful = rawDescription.length > 0
    && normalise(rawDescription) !== normalise(story.headline ?? '');
  const contextLine = contextUseful ? `Context: ${rawDescription.slice(0, 400)}` : null;

  const lines = [
    `Headline: ${story.headline}`,
    `Source: ${story.source}`,
    `Severity: ${story.threatLevel}`,
    `Category: ${story.category}`,
    `Country: ${story.country}`,
    ...(contextLine ? [contextLine] : []),
    '',
    'One editorial sentence describing what happened (not why it matters):',
  ];
  return { system: STORY_DESCRIPTION_SYSTEM, user: lines.join('\n') };
}

/**
 * Parse + validate the LLM story-description output. Rejects empty
 * responses, boilerplate preambles that slipped through the system
 * prompt, outputs that trivially echo the headline (sanity guard
 * against models that default to copying the prompt), and lengths
 * that drift far outside the prompted range.
 *
 * @param {unknown} text
 * @param {string} [headline]  used to detect headline-echo drift
 * @returns {string | null}
 */
export function parseStoryDescription(text, headline) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  if (!s) return null;
  s = s.replace(/^[\u201C"']+/, '').replace(/[\u201D"']+$/, '').trim();
  const match = s.match(/^[^.!?]+[.!?]/);
  const sentence = match ? match[0].trim() : s;
  if (sentence.length < 40 || sentence.length > 400) return null;
  if (typeof headline === 'string') {
    const normalise = /** @param {string} x */ (x) => x.trim().toLowerCase().replace(/\s+/g, ' ');
    // Reject outputs that are a verbatim echo of the headline — that
    // is exactly the fallback we're replacing, shipping it as
    // "LLM enrichment" would be dishonest about cache spend.
    if (normalise(sentence) === normalise(headline)) return null;
  }
  return sentence;
}

/**
 * Resolve a description sentence for one story via cache → LLM.
 * Returns null on any failure; caller falls back to the composer's
 * baseline (cleaned headline) rather than shipping with a placeholder.
 *
 * @param {object} story
 * @param {{
 *   callLLM: (system: string, user: string, opts: object) => Promise<string|null>;
 *   cacheGet: (key: string) => Promise<unknown>;
 *   cacheSet: (key: string, value: unknown, ttlSec: number) => Promise<void>;
 * }} deps
 */
export async function generateStoryDescription(story, deps) {
  // Shares hashBriefStory() with whyMatters — the key prefix
  // (`brief:llm:description:v2:`) is what separates the two cache
  // namespaces; the material is the six fields including description.
  // Bumped v1→v2 on 2026-04-24 alongside the RSS-description fix so
  // cached pre-grounding output (hallucinated named actors from
  // headline-only prompts) is evicted. hashBriefStory itself includes
  // description in the hash material, so content drift invalidates
  // naturally too — the prefix bump is belt-and-braces.
  const key = `brief:llm:description:v2:${await hashBriefStory(story)}`;
  try {
    const hit = await deps.cacheGet(key);
    if (typeof hit === 'string') {
      // Revalidate on cache hit so a pre-fix bad row (short, echo,
      // malformed) can't flow into the envelope unchecked.
      const valid = parseStoryDescription(hit, story.headline);
      if (valid) return valid;
    }
  } catch { /* cache miss is fine */ }
  // Sanitise the story BEFORE building the prompt. `description` (RSS body)
  // is untrusted input; without sanitisation, a hostile feed's
  // `<description>` would be an injection vector. The whyMatters path
  // already does this — keep the two symmetric.
  const { system, user } = buildStoryDescriptionPrompt(sanitizeStoryForPrompt(story));
  let text = null;
  try {
    text = await deps.callLLM(system, user, {
      maxTokens: 140,
      temperature: 0.4,
      timeoutMs: 10_000,
      skipProviders: BRIEF_LLM_SKIP_PROVIDERS,
    });
  } catch {
    return null;
  }
  const parsed = parseStoryDescription(text, story.headline);
  if (!parsed) return null;
  try {
    await deps.cacheSet(key, parsed, STORY_DESCRIPTION_TTL_SEC);
  } catch { /* ignore */ }
  return parsed;
}

// ── Digest prose (canonical synthesis) ─────────────────────────────────────
//
// This is the single LLM call that produces the brief's executive summary.
// All channels (email HTML, plain-text, Telegram, Slack, Discord, webhook)
// AND the magazine's `digest.lead` read the same string from this output.
// The cron orchestration layer also produces a separate non-personalised
// `publicLead` via `generateDigestProsePublic` for the share-URL surface.

const DIGEST_PROSE_SYSTEM_BASE =
  'You are the chief editor of WorldMonitor Brief. Given a ranked list of ' +
  "today's top stories for a reader, produce EXACTLY this JSON and nothing " +
  'else (no markdown, no code fences, no preamble):\n' +
  '{\n' +
  '  "lead": "<2–3 sentences. The FIRST sentence MUST name the single most ' +
  "impactful development by its specific actor and event (e.g. \"Pentagon " +
  "chief Hegseth declared the US blockade on Iran is going global\"), NOT " +
  'an editorial framing about "geopolitical tensions" or "shifting ' +
  'landscapes". Subsequent sentences may give brief context. Reference at ' +
  'most 1–2 threads. No vapid hedging.>",\n' +
  '  "threads": [\n' +
  '    { "tag": "<one-word editorial category e.g. Energy, Diplomacy, Climate>", ' +
  '"teaser": "<one sentence naming a SPECIFIC event or actor — e.g. ' +
  '\\"Hegseth fired Navy Secretary Phelan amid Iran-policy rift\\" — NOT ' +
  'generic phrasing like \\"tensions continue to develop\\".>" }\n' +
  '  ],\n' +
  '  "signals": ["<forward-looking imperative phrase, <=14 words, naming a ' +
  'specific watch-item — e.g. \\"Watch for direct US-Iran naval engagement ' +
  'in the Strait of Hormuz\\".>"],\n' +
  '  "rankedStoryHashes": ["<short hash from the [h:XXXX] prefix of the most ' +
  'important story>", "..."]\n' +
  '}\n' +
  'BANNED phrasing (do NOT use any of these — they are vapid editorial ' +
  'filler that hides which events actually matter): "the global stage", ' +
  '"buzzing with developments", "intricate shifts", "evolving landscape", ' +
  '"navigating", "discerning reader", "continues to simmer", "shape the ' +
  'coming months", "strategic importance".\n' +
  'Threads: 3–6 items reflecting actual clusters in the stories. ' +
  'Signals: 2–4 items, forward-looking. ' +
  'rankedStoryHashes: at least the top 3 stories by editorial importance, ' +
  'using the short hash from each story line (the value inside [h:...]). ' +
  'Lead with the single most impactful development NAMED. Lead under 250 words.';

/**
 * Compute a coarse greeting bucket for cache-key stability.
 * Greeting strings can vary in punctuation/capitalisation across
 * locales; the bucket collapses them to one of three slots so the
 * cache key only changes when the time-of-day window changes.
 *
 * Unrecognised greetings (locale-specific phrases the keyword
 * heuristic doesn't match, empty strings after locale changes,
 * non-string inputs) collapse to the literal `''` slot. This is
 * INTENTIONAL — it's a stable fourth bucket, not a sentinel for
 * "missing data". A user whose greeting flips between a recognised
 * value (e.g. "Good morning") and an unrecognised one (e.g. a
 * locale-specific phrase) will get different cache keys, which is
 * correct: those produce visibly different leads. Greptile P2 on
 * PR #3396 raised the visibility, kept the behaviour.
 *
 * @param {string|null|undefined} greeting
 * @returns {'morning' | 'afternoon' | 'evening' | ''}
 */
export function greetingBucket(greeting) {
  if (typeof greeting !== 'string') return '';
  const g = greeting.toLowerCase();
  if (g.includes('morning')) return 'morning';
  if (g.includes('afternoon')) return 'afternoon';
  if (g.includes('evening') || g.includes('night')) return 'evening';
  return '';
}

/**
 * @typedef {object} DigestPromptCtx
 * @property {string|null} [profile]   formatted user profile lines, or null for non-personalised
 * @property {string|null} [greeting]  e.g. "Good morning", or null for non-personalised
 * @property {boolean}     [isPublic]  true = strip personalisation, build a generic lead
 */

/**
 * Build the digest-prose prompt. When `ctx.profile` / `ctx.greeting`
 * are present (and `ctx.isPublic !== true`), the prompt asks the
 * model to address the reader by their watched assets/regions and
 * open with the greeting. Otherwise the prompt produces a generic
 * editorial brief safe for share-URL surfaces.
 *
 * Per-story line format includes a stable short-hash prefix:
 *   `01 [h:abc12345] [CRITICAL] Headline — Category · Country · Source`
 * The model emits `rankedStoryHashes` referencing those short hashes
 * so the cron can re-order envelope.stories before the cap.
 *
 * @param {Array<{ hash?: string; headline: string; threatLevel: string; category: string; country: string; source: string }>} stories
 * @param {string} sensitivity
 * @param {DigestPromptCtx} [ctx]
 * @returns {{ system: string; user: string }}
 */
export function buildDigestPrompt(stories, sensitivity, ctx = {}) {
  const isPublic = ctx?.isPublic === true;
  const profile = !isPublic && typeof ctx?.profile === 'string' ? ctx.profile.trim() : '';
  const greeting = !isPublic && typeof ctx?.greeting === 'string' ? ctx.greeting.trim() : '';

  const lines = stories.slice(0, MAX_STORIES_PER_USER).map((s, i) => {
    const n = String(i + 1).padStart(2, '0');
    const sev = (s.threatLevel ?? '').toUpperCase();
    // Short hash prefix — first 8 chars of digest story hash. Keeps
    // the prompt compact while remaining collision-free for ≤30
    // stories. Stories without a hash fall back to position-based
    // 'p<NN>' so the prompt is always well-formed.
    const shortHash = typeof s.hash === 'string' && s.hash.length >= 8
      ? s.hash.slice(0, 8)
      : `p${n}`;
    return `${n}. [h:${shortHash}] [${sev}] ${s.headline} — ${s.category} · ${s.country} · ${s.source}`;
  });

  const userParts = [
    `Reader sensitivity level: ${sensitivity}`,
  ];
  if (greeting) {
    userParts.push('', `Open the lead with: "${greeting}."`);
  }
  if (profile) {
    userParts.push('', 'Reader profile (use to personalise lead and signals):', profile);
  }
  userParts.push('', "Today's surfaced stories (ranked):", ...lines);

  return { system: DIGEST_PROSE_SYSTEM_BASE, user: userParts.join('\n') };
}

// Back-compat alias for tests that import the old constant name.
export const DIGEST_PROSE_SYSTEM = DIGEST_PROSE_SYSTEM_BASE;

/**
 * Strict shape check for a parsed digest-prose object. Used by BOTH
 * parseDigestProse (fresh LLM output) AND generateDigestProse's
 * cache-hit path, so a bad row written under an older/buggy version
 * can't poison the envelope at SETEX time. Returns a **normalised**
 * copy of the object on success, null on any shape failure — never
 * returns the caller's object by reference so downstream writes
 * can't observe internal state.
 *
 * v3 (2026-04-25): adds optional `rankedStoryHashes` — short hashes
 * (≥4 chars each) that the orchestration layer maps back to digest
 * story `hash` values to re-order envelope.stories before the cap.
 * Field is optional so v2-shaped cache rows still pass validation
 * during the rollout window — they just don't carry ranking signal.
 *
 * @param {unknown} obj
 * @returns {{ lead: string; threads: Array<{tag:string;teaser:string}>; signals: string[]; rankedStoryHashes: string[] } | null}
 */
export function validateDigestProseShape(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const lead = typeof obj.lead === 'string' ? obj.lead.trim() : '';
  if (lead.length < 40 || lead.length > 1500) return null;

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

  // The prompt instructs the model to produce signals of "<=14 words,
  // forward-looking imperative phrase". Enforce both a word cap (with
  // a small margin of 4 words for model drift and compound phrases)
  // and a byte cap — a 30-word "signal" would render as a second
  // paragraph on the signals page, breaking visual rhythm. Previously
  // only the byte cap was enforced, allowing ~40-word signals to
  // sneak through when the model ignored the word count.
  const rawSignals = Array.isArray(obj.signals) ? obj.signals : [];
  const signals = rawSignals
    .filter((x) => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => {
      if (x.length === 0 || x.length >= 220) return false;
      const words = x.split(/\s+/).filter(Boolean).length;
      return words <= 18;
    })
    .slice(0, 6);

  // rankedStoryHashes: optional. When present, must be array of
  // non-empty short-hash strings (≥4 chars). Each entry trimmed and
  // capped to 16 chars (the prompt emits 8). Length capped to
  // MAX_STORIES_PER_USER × 2 to bound prompt drift.
  const rawRanked = Array.isArray(obj.rankedStoryHashes) ? obj.rankedStoryHashes : [];
  const rankedStoryHashes = rawRanked
    .filter((x) => typeof x === 'string')
    .map((x) => x.trim().slice(0, 16))
    .filter((x) => x.length >= 4)
    .slice(0, MAX_STORIES_PER_USER * 2);

  return { lead, threads, signals, rankedStoryHashes };
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
  return validateDigestProseShape(obj);
}

/**
 * Cache key for digest prose. MUST cover every field the LLM sees,
 * in the order it sees them — anything less and we risk returning
 * pre-computed prose for a materially different prompt (e.g. the
 * same stories re-ranked, or with corrected category/country
 * metadata). The old "sort + headline|severity" hash was explicitly
 * about cache-hit rate; that optimisation is the wrong tradeoff for
 * an editorial product whose correctness bar is "matches the email".
 *
 * v3 key space (2026-04-25): material now includes the digest-story
 * `hash` (per-story rankability), `ctx.profile` SHA-256, greeting
 * bucket, and isPublic flag. When `ctx.isPublic === true` the userId
 * slot is replaced with the literal `'public'` so all public-share
 * readers of the same (sensitivity, story-pool) hit ONE cache row
 * regardless of caller — no PII in public cache keys, no per-user
 * inflation. v2 rows are ignored on rollout (paid for once).
 *
 * @param {string} userId
 * @param {Array} stories
 * @param {string} sensitivity
 * @param {DigestPromptCtx} [ctx]
 */
function hashDigestInput(userId, stories, sensitivity, ctx = {}) {
  const isPublic = ctx?.isPublic === true;
  const profileSha = isPublic ? '' : (typeof ctx?.profile === 'string' && ctx.profile.length > 0
    ? createHash('sha256').update(ctx.profile).digest('hex').slice(0, 16)
    : '');
  const greetingSlot = isPublic ? '' : greetingBucket(ctx?.greeting);
  // Canonicalise as JSON of the fields the prompt actually references,
  // in the prompt's ranked order. Stable stringification via an array
  // of tuples keeps field ordering deterministic without relying on
  // JS object-key iteration order. Slice MUST match buildDigestPrompt's
  // slice or the cache key drifts from the prompt content.
  const material = JSON.stringify([
    sensitivity ?? '',
    profileSha,
    greetingSlot,
    isPublic ? 'public' : 'private',
    ...stories.slice(0, MAX_STORIES_PER_USER).map((s) => [
      // hash drives ranking (model emits rankedStoryHashes); without
      // it the cache ignores re-ranking and stale ordering is served.
      typeof s.hash === 'string' ? s.hash.slice(0, 8) : '',
      s.headline ?? '',
      s.threatLevel ?? '',
      s.category ?? '',
      s.country ?? '',
      s.source ?? '',
    ]),
  ]);
  const h = createHash('sha256').update(material).digest('hex').slice(0, 16);
  // userId-slot substitution for public mode — one cache row per
  // (sensitivity, story-pool) shared across ALL public readers.
  const userSlot = isPublic ? 'public' : userId;
  return `${userSlot}:${sensitivity}:${h}`;
}

/**
 * Resolve the digest prose object via cache → LLM.
 *
 * Backward-compatible signature: existing 4-arg callers behave like
 * today (no profile/greeting → non-personalised lead). New callers
 * pass `ctx` to enable canonical synthesis with greeting + profile.
 *
 * @param {string} userId
 * @param {Array} stories
 * @param {string} sensitivity
 * @param {{ callLLM: Function; cacheGet: Function; cacheSet: Function }} deps
 * @param {DigestPromptCtx} [ctx]
 */
export async function generateDigestProse(userId, stories, sensitivity, deps, ctx = {}) {
  // v4 key (2026-04-25 evening): bumped from v3 when the prompt
  // gained a BANNED-phrasing list + "name the specific actor and
  // event" lead instructions, after a regression where evening
  // briefs shipped vapid editorial filler ("the global stage is
  // buzzing", "navigating the evolving landscape"). v3 cache rows
  // still in TTL would otherwise serve stale vapid leads for 4h
  // post-deploy.
  const key = `brief:llm:digest:v4:${hashDigestInput(userId, stories, sensitivity, ctx)}`;
  try {
    const hit = await deps.cacheGet(key);
    // CRITICAL: re-run the shape validator on cache hits. Without
    // this, a bad row (written under an older buggy code path, or
    // partial write, or tampered Redis) flows straight into
    // envelope.data.digest and the envelope later fails
    // assertBriefEnvelope() at the /api/brief render boundary. The
    // user's brief URL then 404s / expired-pages. Treat a
    // shape-failed hit the same as a miss — re-LLM and overwrite.
    if (hit) {
      const validated = validateDigestProseShape(hit);
      if (validated) return validated;
    }
  } catch { /* cache miss fine */ }
  const { system, user } = buildDigestPrompt(stories, sensitivity, ctx);
  let text = null;
  try {
    text = await deps.callLLM(system, user, {
      maxTokens: 900,
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

/**
 * Non-personalised wrapper for share-URL surfaces. Strips profile
 * and greeting; substitutes 'public' for userId in the cache key
 * (see hashDigestInput) so all public-share readers of the same
 * (sensitivity, story-pool) hit one cache row.
 *
 * Note the missing `userId` parameter — by design. Callers MUST
 * NOT thread their authenticated user's id through this function;
 * the public lead must never carry per-user salt.
 *
 * @param {Array} stories
 * @param {string} sensitivity
 * @param {{ callLLM: Function; cacheGet: Function; cacheSet: Function }} deps
 * @returns {ReturnType<typeof generateDigestProse>}
 */
export async function generateDigestProsePublic(stories, sensitivity, deps) {
  // userId param to generateDigestProse is unused when isPublic=true
  // (see hashDigestInput's userSlot logic). Pass an empty string so
  // a typo on a future caller can't accidentally salt the public
  // cache.
  return generateDigestProse('', stories, sensitivity, deps, {
    profile: null,
    greeting: null,
    isPublic: true,
  });
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
  // Default to 'high' (NOT 'all') so the digest prompt and cache key
  // align with what the rest of the pipeline (compose, buildDigest,
  // cache, log) treats undefined-sensitivity rules as. Mismatched
  // defaults would (a) mislead personalization — the prompt would say
  // "Reader sensitivity level: all" while the actual brief contains
  // only critical/high stories — and (b) bust the cache for legacy
  // rules vs explicit-'all' rules that should share entries. See PR
  // #3387 review (P3).
  const sensitivity = rule?.sensitivity ?? 'high';

  // Per-story enrichment — whyMatters AND description in parallel
  // per story (two LLM calls) but bounded across stories.
  const enrichedStories = await mapLimit(stories, WHY_MATTERS_CONCURRENCY, async (story) => {
    const [why, desc] = await Promise.all([
      generateWhyMatters(story, deps),
      generateStoryDescription(story, deps),
    ]);
    if (!why && !desc) return story;
    return {
      ...story,
      ...(why ? { whyMatters: why } : {}),
      ...(desc ? { description: desc } : {}),
    };
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
