// Declaration file for the dependency-free timeout policy shared by the
// Railway forecast workers and bundled server code.
export const DEEPSEEK_V4_FLASH_MODEL_PREFIX: string;
export const DEEPSEEK_V4_FLASH_COMPLETION_TIMEOUT_MS: number;

export function isDeepseekV4FlashModel(model: string): boolean;
export function getLlmAttemptTimeoutMs(model: string, requestedTimeoutMs: number): number;
