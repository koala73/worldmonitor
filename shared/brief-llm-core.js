// @ts-check
/**
 * Edge-safe pure helpers for the brief LLM enrichment path. Shared by:
 *   - scripts/lib/brief-llm.mjs   (Railway cron, Node)
 *   - api/internal/brief-why-matters.ts  (Vercel edge)
 *
 * No `node:*` imports. Hashing via Web Crypto (`crypto.subtle.digest`),
 * which is available in both Edge and modern Node. Everything else is
 * pure string manipulation.
 *
 * Any change here MUST be mirrored byte-for-byte to
 * `scripts/shared/brief-llm-core.js` (enforced by the shared-mirror
 * parity test; see `feedback_shared_dir_mirror_requirement`).
 */

/**
 * System prompt for the one-sentence "why this matters" enrichment.
 * Moved verbatim from scripts/lib/brief-llm.mjs so the edge endpoint
 * and the cron fallback emit the identical editorial voice.
 */
export const WHY_MATTERS_SYSTEM =
  'You are the editor of WorldMonitor Brief, a geopolitical intelligence magazine. ' +
  'For each story below, write ONE concise sentence (18–30 words) explaining the ' +
  'regional or global stakes. Editorial, impersonal, serious. No preamble ' +
  '("This matters because…"), no questions, no calls to action, no markdown, ' +
  'no quotes. One sentence only.';

/**
 * @param {{
 *   headline: string;
 *   source: string;
 *   threatLevel: string;
 *   category: string;
 *   country: string;
 * }} story
 * @returns {{ system: string; user: string }}
 */
export function buildWhyMattersUserPrompt(story) {
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
  s = s.replace(/^[\u201C"']+/, '').replace(/[\u201D"']+$/, '').trim();
  const match = s.match(/^[^.!?]+[.!?]/);
  const sentence = match ? match[0].trim() : s;
  if (sentence.length < 30 || sentence.length > 400) return null;
  if (/^story flagged by your sensitivity/i.test(sentence)) return null;
  return sentence;
}

/**
 * Deterministic 16-char hex hash of the five story fields that flow
 * into the whyMatters prompt. Same material as the pre-v3 sync
 * implementation (`scripts/lib/brief-llm.mjs:hashBriefStory`) — a
 * fixed fixture in tests/brief-llm-core.test.mjs pins the output so a
 * future refactor cannot silently invalidate every cached entry.
 *
 * Uses Web Crypto so the module is edge-safe. Returns a Promise because
 * `crypto.subtle.digest` is async; cron call sites are already in an
 * async context so the await is free.
 *
 * @param {{
 *   headline?: string;
 *   source?: string;
 *   threatLevel?: string;
 *   category?: string;
 *   country?: string;
 * }} story
 * @returns {Promise<string>}
 */
export async function hashBriefStory(story) {
  const material = [
    story.headline ?? '',
    story.source ?? '',
    story.threatLevel ?? '',
    story.category ?? '',
    story.country ?? '',
  ].join('||');
  const bytes = new TextEncoder().encode(material);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  let hex = '';
  const view = new Uint8Array(digest);
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, '0');
  }
  return hex.slice(0, 16);
}
