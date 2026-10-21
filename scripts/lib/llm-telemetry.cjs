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

// In-flight deliveries. Fire-and-forget callers race explicit
// process.exit() paths (which do NOT drain pending promises) —
// flushPendingLlmEvents() lets exit sites drain within the fetch timeout.
const pendingDeliveries = new Set();

/**
 * Deliver events to the wm_api_usage dataset. No-op unless USAGE_TELEMETRY=1
 * and AXIOM_API_TOKEN are set. Never throws.
 *
 * Callers fire-and-forget (`void emitLlmEvents(events)`) so telemetry never
 * adds latency to the LLM return path. Seeders that exit explicitly must
 * `await flushPendingLlmEvents()` before process.exit() or in-flight POSTs
 * are dropped.
 * @param {Array<Record<string, unknown>>} events
 */
function emitLlmEvents(events) {
  if (process.env.USAGE_TELEMETRY !== '1' || !Array.isArray(events) || events.length === 0) return Promise.resolve();
  const token = process.env.AXIOM_API_TOKEN;
  if (!token) return Promise.resolve();
  const delivery = (async () => {
    try {
      await fetch(AXIOM_WM_API_USAGE_INGEST_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'worldmonitor-seeder-telemetry/1.0',
        },
        body: JSON.stringify(events),
        signal: AbortSignal.timeout(1_500),
      });
    } catch { /* telemetry must never affect the seed */ }
  })();
  pendingDeliveries.add(delivery);
  delivery.finally(() => pendingDeliveries.delete(delivery));
  return delivery;
}

/**
 * Bounded drain of in-flight telemetry POSTs — call before explicit
 * process.exit(). Each delivery is capped by its own 1.5s fetch timeout and
 * swallows errors, so this resolves quickly and never throws.
 */
async function flushPendingLlmEvents() {
  if (pendingDeliveries.size === 0) return;
  await Promise.allSettled([...pendingDeliveries]);
}

module.exports = { buildLlmCallEvent, emitLlmEvents, flushPendingLlmEvents, AXIOM_WM_API_USAGE_INGEST_URL };
