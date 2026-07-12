// Shared model-specific LLM timeout policy. This module lives in scripts/
// because Railway forecast workers package only that directory; server code
// can import it and Vercel's build inlines the dependency.
export const DEEPSEEK_V4_FLASH_MODEL_PREFIX = 'deepseek/deepseek-v4-flash';

// This is a non-streaming completion deadline, not a first-token deadline.
// Keep it above the pinned endpoint's observed p50 while cutting off the 25s stall tail.
export const DEEPSEEK_V4_FLASH_COMPLETION_TIMEOUT_MS = 15_000;

export function isDeepseekV4FlashModel(model) {
  return model.startsWith(DEEPSEEK_V4_FLASH_MODEL_PREFIX);
}

export function getLlmAttemptTimeoutMs(model, requestedTimeoutMs) {
  return isDeepseekV4FlashModel(model)
    ? Math.min(requestedTimeoutMs, DEEPSEEK_V4_FLASH_COMPLETION_TIMEOUT_MS)
    : requestedTimeoutMs;
}
