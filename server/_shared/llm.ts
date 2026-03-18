/**
 * Unified LLM Provider — Ollama (local Llama) primary, Claude API fallback.
 *
 * Provider chain: Ollama (local, free, private) → Claude (Anthropic API)
 *
 * No Groq. No OpenRouter. Two providers, both high quality.
 * Ollama runs your own Llama 3.2 3B locally — zero latency, zero cost.
 * Claude API is the fallback when local inference is unavailable.
 */

declare const process: { env: Record<string, string | undefined> };

// ============================================================================
// TYPES
// ============================================================================

export interface LLMRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  /** Force JSON output parsing */
  jsonMode?: boolean;
}

export interface LLMResponse {
  content: string;
  provider: string;
  model: string;
  cached: boolean;
  latencyMs: number;
}

export interface ProviderConfig {
  id: string;
  name: string;
  apiUrl: string;
  model: string;
  headers: Record<string, string>;
  extraBody?: Record<string, unknown>;
  /** 'openai' for Ollama compat, 'anthropic' for Claude Messages API */
  apiFormat: 'openai' | 'anthropic';
  available: boolean;
  priority: number;
}

// ============================================================================
// PROVIDER RESOLUTION — Ollama → Claude. That's it.
// ============================================================================

export function resolveProviders(): ProviderConfig[] {
  const providers: ProviderConfig[] = [];

  // Priority 0: Ollama (local Llama — primary, always preferred)
  const ollamaUrl = process.env.OLLAMA_API_URL;
  if (ollamaUrl) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const apiKey = process.env.OLLAMA_API_KEY;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    providers.push({
      id: 'ollama',
      name: 'Ollama (Local Llama)',
      apiUrl: new URL('/v1/chat/completions', ollamaUrl).toString(),
      model: process.env.OLLAMA_MODEL || 'llama3.2:3b',
      headers,
      extraBody: { think: false },
      apiFormat: 'openai',
      available: true,
      priority: 0,
    });
  }

  // Priority 1: Claude (Anthropic API — cloud fallback)
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    providers.push({
      id: 'claude',
      name: 'Claude (Anthropic)',
      apiUrl: 'https://api.anthropic.com/v1/messages',
      model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      apiFormat: 'anthropic',
      available: true,
      priority: 1,
    });
  }

  return providers.sort((a, b) => a.priority - b.priority);
}

/** Get the primary (highest priority) available provider */
export function getPrimaryProvider(): ProviderConfig | null {
  const providers = resolveProviders();
  return providers[0] ?? null;
}

/** Get the model name of the primary provider */
export function getPrimaryModel(): string {
  return getPrimaryProvider()?.model ?? 'none';
}

// ============================================================================
// CIRCUIT BREAKER
// ============================================================================

interface CircuitState {
  failures: number;
  lastFailure: number;
  open: boolean;
}

const circuits = new Map<string, CircuitState>();
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_RESET_MS = 60_000;

function isCircuitOpen(providerId: string): boolean {
  const state = circuits.get(providerId);
  if (!state || !state.open) return false;
  if (Date.now() - state.lastFailure > CIRCUIT_RESET_MS) {
    state.open = false;
    state.failures = 0;
    return false;
  }
  return true;
}

function recordFailure(providerId: string): void {
  const state = circuits.get(providerId) ?? { failures: 0, lastFailure: 0, open: false };
  state.failures++;
  state.lastFailure = Date.now();
  if (state.failures >= CIRCUIT_THRESHOLD) state.open = true;
  circuits.set(providerId, state);
}

function recordSuccess(providerId: string): void {
  circuits.set(providerId, { failures: 0, lastFailure: 0, open: false });
}

// ============================================================================
// CORE INFERENCE — Ollama first, Claude fallback
// ============================================================================

const UPSTREAM_TIMEOUT_MS = 30_000;

export async function infer(req: LLMRequest): Promise<LLMResponse | null> {
  const providers = resolveProviders();
  if (providers.length === 0) return null;

  for (const provider of providers) {
    if (isCircuitOpen(provider.id)) continue;

    try {
      const start = Date.now();

      const resp = provider.apiFormat === 'anthropic'
        ? await callAnthropic(provider, req)
        : await callOpenAI(provider, req);

      if (!resp) {
        recordFailure(provider.id);
        continue;
      }

      recordSuccess(provider.id);
      return {
        content: stripThinkingTags(resp),
        provider: provider.id,
        model: provider.model,
        cached: false,
        latencyMs: Date.now() - start,
      };
    } catch {
      recordFailure(provider.id);
      continue;
    }
  }

  return null;
}

// ============================================================================
// OPENAI-COMPATIBLE CALL (Ollama)
// ============================================================================

async function callOpenAI(provider: ProviderConfig, req: LLMRequest): Promise<string | null> {
  const body: Record<string, unknown> = {
    model: provider.model,
    messages: [
      { role: 'system', content: req.systemPrompt },
      { role: 'user', content: req.userPrompt },
    ],
    temperature: req.temperature ?? 0,
    max_tokens: req.maxTokens ?? 150,
    ...provider.extraBody,
  };

  const resp = await fetch(provider.apiUrl, {
    method: 'POST',
    headers: provider.headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  if (!resp.ok) return null;

  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content?.trim() ?? '';
  return content || null;
}

// ============================================================================
// ANTHROPIC MESSAGES API CALL (Claude)
// ============================================================================

async function callAnthropic(provider: ProviderConfig, req: LLMRequest): Promise<string | null> {
  const body = {
    model: provider.model,
    max_tokens: req.maxTokens ?? 150,
    system: req.systemPrompt,
    messages: [
      { role: 'user', content: req.userPrompt },
    ],
    temperature: req.temperature ?? 0,
  };

  const resp = await fetch(provider.apiUrl, {
    method: 'POST',
    headers: provider.headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  if (!resp.ok) return null;

  const data = (await resp.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const content = data.content?.find(c => c.type === 'text')?.text?.trim() ?? '';
  return content || null;
}

// ============================================================================
// CONVENIENCE: JSON inference
// ============================================================================

export async function inferJSON<T = unknown>(req: LLMRequest): Promise<{ data: T; provider: string; model: string } | null> {
  const response = await infer({ ...req, jsonMode: true });
  if (!response) return null;

  try {
    let jsonStr = response.content;
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1]!;

    const data = JSON.parse(jsonStr.trim()) as T;
    return { data, provider: response.provider, model: response.model };
  } catch {
    return null;
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function stripThinkingTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/<reflection>[\s\S]*?<\/reflection>/gi, '')
    .trim();
}

/** Get status of all providers for diagnostics */
export function getProviderStatus(): Array<{
  id: string;
  name: string;
  model: string;
  available: boolean;
  circuitOpen: boolean;
  failures: number;
}> {
  return resolveProviders().map(p => {
    const circuit = circuits.get(p.id);
    return {
      id: p.id,
      name: p.name,
      model: p.model,
      available: p.available,
      circuitOpen: circuit?.open ?? false,
      failures: circuit?.failures ?? 0,
    };
  });
}
