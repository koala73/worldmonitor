type LlmEnvironment = Record<string, string | undefined>;
export function isExplicitGenericLlmSelected(env?: LlmEnvironment): boolean;
export function isGenericLlmSelected(env?: LlmEnvironment): boolean;
export function genericLlmCacheIdentity(env?: LlmEnvironment): string;
export function buildGenericLlmProvider(env?: LlmEnvironment): {
  name: string;
  envKey: string;
  apiUrl: string;
  model: string;
  headers: () => Record<string, string>;
  timeout: number;
} | null;
