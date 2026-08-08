// Shared model-specific LLM timeout + OpenRouter routing policy. This module lives
// in scripts/ because Railway forecast workers package only that directory; server
// code can import it and Vercel's build inlines the dependency.
//
// Timeout and routing live TOGETHER on purpose: the Flash completion timeout is only
// meaningful under throughput-sorted routing. seed-forecasts previously had the
// timeout but NOT the routing (the routing existed only in server/_shared/llm.ts),
// so OpenRouter free-routed its calls to backends 4-7x slower than the timeout
// allowed and every market_implications run failed. Keeping both here means a
// consumer cannot pick up one without the other.
export const DEEPSEEK_V4_FLASH_MODEL_PREFIX = 'deepseek/deepseek-v4-flash';

// OpenRouter provider routing. WorldMonitor is a geopolitical product, so inference
// must never physically run on a China-hosted provider — one could log queries or
// bias outputs on the exact topics we cover (Taiwan, Xinjiang, the South China Sea,
// etc.). We BLOCK the known China-based providers and let OpenRouter serve the model
// (DeepSeek weights are fine; hosting is the concern) from the fastest of the rest.
//   - `ignore`: blocklist. These MUST be OpenRouter's lowercase provider SLUGS (from
//     GET /api/v1/providers), NOT display names — OpenRouter silently drops
//     unrecognized entries, so a display name like "DeepSeek" matches nothing and the
//     block is a no-op (caught in #4993 review). Verified against /providers
//     2026-07-07. RE-AUDIT periodically — a new China-based entrant would otherwise
//     be eligible, and an entry here may be MIS-classified (novita is
//     San-Francisco-headquartered; its GPU hosting is not publicly disclosed).
//   - `sort: throughput`: also steers off OpenRouter's cheapest-but-slowest default
//     to the fastest eligible provider.
// Blocking costs nothing: measured on the market_implications call shape, the
// eligible set (Venice/AtlasCloud) is FASTER than the unrestricted set —
// p50 15.3s / p90 22.4s / max 25.0s vs p50 17.5s / p90 26.4s / max 34.7s.
export const OPENROUTER_BLOCKED_PROVIDERS = [
  'baidu', 'alibaba', 'deepseek', 'siliconflow', 'streamlake', 'novita',
];

export const OPENROUTER_PROVIDER_ROUTING = {
  ignore: OPENROUTER_BLOCKED_PROVIDERS,
  sort: 'throughput',
};

// This is a non-streaming completion deadline, not a first-token deadline.
//
// DEFAULT (15s): short utility completions — the shared server LLM client (brief,
// classification, etc.). Calibrated for those payloads; do not raise it to suit a
// long-generation caller, pass a bigger cap instead.
export const DEEPSEEK_V4_FLASH_COMPLETION_TIMEOUT_MS = 15_000;

// LONG (40s): large generations, e.g. forecast stages at max_tokens 2500, which emit
// ~1.2-1.9k completion tokens. Measured against production under the routing above:
// p50 15.3s, p90 22.4s, max 25.0s across 14 samples => 40s covers 100% with margin.
// The old behaviour clamped these to 15s — BELOW the fastest observed completion —
// so the primary provider could never succeed and every run wrote a SEED_ERROR.
export const DEEPSEEK_V4_FLASH_LONG_COMPLETION_TIMEOUT_MS = 40_000;

export function isDeepseekV4FlashModel(model) {
  return model.startsWith(DEEPSEEK_V4_FLASH_MODEL_PREFIX);
}

// Stays a MIN: a caller asking for LESS than the cap must still get less (the shared
// client passes 8s for some utility calls and must not be silently loosened to 15s).
//
// capMs lets a long-generation caller (forecast stages, max_tokens 2500) opt into a
// bigger ceiling without raising it for every short utility call. The caller is then
// responsible for also requesting a timeout >= capMs — a provider entry's `timeout`
// is shared across whatever model a stage overrides onto it (the forecast openrouter
// entry also serves google/gemini-2.5-flash for critical_signals), so raising THAT to
// suit Flash would silently loosen Gemini too. See resolveForecastLlmProviders, which
// passes a Flash-specific requested timeout and leaves other models on 25s.
export function getLlmAttemptTimeoutMs(
  model,
  requestedTimeoutMs,
  capMs = DEEPSEEK_V4_FLASH_COMPLETION_TIMEOUT_MS,
) {
  return isDeepseekV4FlashModel(model)
    ? Math.min(requestedTimeoutMs, capMs)
    : requestedTimeoutMs;
}
