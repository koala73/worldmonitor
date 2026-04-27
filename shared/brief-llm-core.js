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
 * Deterministic 16-char hex hash of the SIX story fields that flow
 * into the whyMatters prompt (5 core + description). Cache identity
 * MUST cover every field that shapes the LLM output, or two requests
 * with the same core fields but different descriptions will share a
 * cache entry and the second caller gets prose grounded in the first
 * caller's description (P1 regression caught in PR #3269 review).
 *
 * History:
 *   - pre-v3: 5 fields, sync `node:crypto.createHash`.
 *   - v3: moved to Web Crypto (async), same 5 fields.
 *   - v5 (with endpoint cache bump to brief:llm:whymatters:v5:):
 *     6 fields — `description` added to match the analyst path's
 *     v2 prompt which interpolates `Description: <desc>` between
 *     headline and source.
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
 *   description?: string;
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
    // New in v5: description is a prompt input on the analyst path,
    // so MUST be part of cache identity. Absent on legacy paths →
    // empty string → deterministic; same-story-same-description pairs
    // still collide on purpose, different descriptions don't.
    story.description ?? '',
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

// ── Analyst-path prompt v2 (multi-sentence, grounded) ──────────────────────
//
// Shadow-diff on 12 prod stories (2026-04-21) showed the v1 analyst output
// was indistinguishable from the legacy Gemini-only output: identical
// single-sentence abstraction-speak ("destabilize / systemic / sovereign
// risk repricing") with no named actors, metrics, or dates. Root cause:
// the 18–30 word cap compressed the context's specifics out of the LLM's
// response. v2 loosens to 40–70 words across 2–3 sentences and REQUIRES
// the LLM to ground at least one specific reference from the live context.

/**
 * System prompt for the analyst-path v2 (2–3 sentences, ~40–70 words,
 * grounded in a specific named actor / metric / date / place drawn
 * from the live context). Shape nudged toward the WMAnalyst chat voice
 * (SITUATION → ANALYSIS → optional WATCH) but rendered as plain prose,
 * no section labels in the output.
 */
export const WHY_MATTERS_ANALYST_SYSTEM_V2 =
  'You are the lead analyst at WorldMonitor Brief, a geopolitical intelligence magazine. ' +
  'Using the Live WorldMonitor Context AND the story, write 2–3 sentences (40–70 words total) ' +
  'on why the story matters.\n\n' +
  'STRUCTURE:\n' +
  '1. SITUATION — what is happening right now, grounded in a SPECIFIC named actor, ' +
  'metric, date, or place relevant to this story.\n' +
  '2. ANALYSIS — the structural consequence (why this forces a repricing, shifts ' +
  'the balance, triggers a cascade).\n' +
  '3. (Optional) WATCH — the threshold or indicator to track, if clear from the context.\n\n' +
  'HARD CONSTRAINTS:\n' +
  '- Total length 40–70 words across 2–3 sentences.\n' +
  '- MUST reference at least ONE specific: named person / country / organization / ' +
  'number / percentage / date / city.\n' +
  '- No preamble ("This matters because…", "The importance of…").\n' +
  '- No markdown, no bullet points, no section labels in the output — plain prose.\n' +
  '- Editorial, impersonal, serious. No calls to action, no questions, no quotes.\n\n' +
  'RELEVANCE RULE (critical, read carefully):\n' +
  '- The context block may contain facts from world-brief, country-brief, risk scores, ' +
  'forecasts, macro signals, and market data. These are BACKGROUND — only cite what is ' +
  "directly relevant to this story's category and country.\n" +
  '- If NO context fact clearly fits, ground instead in a named actor, place, date, ' +
  'or figure drawn from the headline or description. That is a VALID grounding — do ' +
  'NOT invent a market reading, VIX value, or forecast probability to satisfy the rule.\n' +
  '- NEVER drag an off-topic market metric, FX reading, or probability into a ' +
  'humanitarian, aviation, diplomacy, or cyber story. A story about a refugee flow ' +
  'does not need a VIX number; a story about a drone incursion does not need an FX ' +
  "stress reading. If it isn't editorially connected to the story, leave it out.";

/**
 * Parse + validate the analyst-path v2 LLM response. Accepts
 * multi-sentence output (2–3 sentences), 100–500 chars. Otherwise
 * same rejection semantics as v1 (stub echo, empty) plus explicit
 * rejection of preamble boilerplate and leaked section labels.
 *
 * Returns null when the output is obviously wrong so the caller can
 * fall through to the next layer.
 *
 * @param {unknown} text
 * @returns {string | null}
 */
export function parseWhyMattersV2(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  if (!s) return null;
  // Drop surrounding quotes if the model insisted.
  s = s.replace(/^[\u201C"']+/, '').replace(/[\u201D"']+$/, '').trim();
  if (s.length < 100 || s.length > 500) return null;
  // Reject the stub echo (same as v1).
  if (/^story flagged by your sensitivity/i.test(s)) return null;
  // Reject common preamble the system prompt explicitly banned.
  if (/^(this matters because|the importance of|it is important|importantly,|in summary,|to summarize)/i.test(s)) {
    return null;
  }
  // Reject markdown / section-label leakage (we told it to use plain prose).
  if (/^(#|-|\*|\d+\.\s)/.test(s)) return null;
  if (/^(situation|analysis|watch)\s*[:\-–—]/i.test(s)) return null;
  return s;
}
