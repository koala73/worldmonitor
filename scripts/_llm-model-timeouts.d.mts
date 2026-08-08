// Declaration file for the dependency-free timeout + OpenRouter routing policy
// shared by the Railway forecast workers and bundled server code.
export const DEEPSEEK_V4_FLASH_MODEL_PREFIX: string;
export const DEEPSEEK_V4_FLASH_COMPLETION_TIMEOUT_MS: number;
export const DEEPSEEK_V4_FLASH_LONG_COMPLETION_TIMEOUT_MS: number;

export const OPENROUTER_BLOCKED_PROVIDERS: readonly string[];
export const OPENROUTER_PROVIDER_ROUTING: {
  readonly ignore: readonly string[];
  readonly sort: 'throughput';
};

export function isDeepseekV4FlashModel(model: string): boolean;
export function getLlmAttemptTimeoutMs(
  model: string,
  requestedTimeoutMs: number,
  capMs?: number,
): number;
