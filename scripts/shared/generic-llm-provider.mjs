import { getGenericLlmAuthHeaders } from './generic-llm-auth.mjs';

/**
 * An explicit generic selection is exclusive, including when it is incomplete.
 * Do not send local prompts to a configured cloud provider after a local error.
 */
export function isExplicitGenericLlmSelected(env = process.env) {
  return [env.LLM_PROVIDER, env.LLM_TOOL_PROVIDER, env.LLM_REASONING_PROVIDER]
    .some((value) => value?.trim() === 'generic');
}

export function isGenericLlmSelected(env = process.env) {
  return isExplicitGenericLlmSelected(env)
    || Boolean(env.LLM_API_URL && !env.OPENROUTER_API_KEY && !env.OLLAMA_API_URL);
}

/** OpenAI-compatible provider shape used by standalone worker transports. */
export function buildGenericLlmProvider(env = process.env) {
  const auth = getGenericLlmAuthHeaders(env.LLM_API_KEY, env.LLM_API_AUTH_TYPE);
  if (!env.LLM_API_URL || !env.LLM_MODEL || !auth) return null;
  return {
    name: 'generic',
    envKey: 'LLM_API_KEY',
    apiUrl: env.LLM_API_URL,
    model: env.LLM_MODEL,
    headers: () => ({
      ...auth,
      'Content-Type': 'application/json',
      'User-Agent': 'worldmonitor-llm/1.0',
    }),
    timeout: 30_000,
  };
}

/** Model identity for cache partitioning; never includes credentials. */
export function genericLlmCacheIdentity(env = process.env) {
  return isGenericLlmSelected(env)
    ? JSON.stringify(['generic', env.LLM_API_URL || '', env.LLM_MODEL || ''])
    : '';
}
