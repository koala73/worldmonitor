'use strict';

// Seeder-side llm_call telemetry shared helper (#4944 U5, refs #4948).
//
// Mirrors server/_shared/usage.ts LlmCallEvent field-for-field (and
// seed-forecasts.mjs's local emitter, #4895/post-#4901) so seeder events
// unify with the Vercel-side stream in one wm_api_usage APL query. Gated on
// USAGE_TELEMETRY=1 + AXIOM_API_TOKEN. Best-effort: one bounded POST per
// logical call, never throws, never fails a seed.
//
// CommonJS on purpose: consumed by both CJS (scripts/lib/llm-chain.cjs) and
// ESM (seed-insights, regional-snapshot/*) — Node ESM imports CJS natively;
// the reverse needs dynamic import.

const AXIOM_WM_API_USAGE_INGEST_URL = 'https://api.axiom.co/v1/datasets/wm_api_usage/ingest';

/**
 * Build one llm_call event for a single provider attempt.
 * @param {{ provider: string, model: string, stage: string, ok: boolean,
 *   durationMs: number, tokensTotal?: number, tokensPrompt?: number,
 *   tokensCompletion?: number, promptChars?: number, maxTokens?: number,
 *   fallbackIndex?: number, reason?: string }} p
 */
function buildLlmCallEvent(p) {
  return {
    _time: new Date().toISOString(),
    event_type: 'llm_call',
    provider: p.provider,
    model: p.model,
    stage: p.stage,
    ok: p.ok,
    duration_ms: Math.round(p.durationMs || 0),
    tokens_total: p.tokensTotal ?? 0,
    tokens_prompt: p.tokensPrompt ?? 0,
    tokens_completion: p.tokensCompletion ?? 0,
    prompt_chars: p.promptChars ?? 0,
    max_tokens: p.maxTokens ?? 0,
    fallback_index: p.fallbackIndex ?? 0,
    reason: p.reason || '',
  };
}

/**
 * Deliver events to the wm_api_usage dataset. No-op unless USAGE_TELEMETRY=1
 * and AXIOM_API_TOKEN are set. Never throws.
 * @param {Array<Record<string, unknown>>} events
 */
async function emitLlmEvents(events) {
  if (process.env.USAGE_TELEMETRY !== '1' || !Array.isArray(events) || events.length === 0) return;
  const token = process.env.AXIOM_API_TOKEN;
  if (!token) return;
  try {
    await fetch(AXIOM_WM_API_USAGE_INGEST_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(events),
      signal: AbortSignal.timeout(1_500),
    });
  } catch { /* telemetry must never affect the seed */ }
}

module.exports = { buildLlmCallEvent, emitLlmEvents, AXIOM_WM_API_USAGE_INGEST_URL };
