import Anthropic from '@anthropic-ai/sdk';

// Direct Anthropic Messages API provider for llm.ts. It is never part of the
// default provider chain: callers reach it only through a customer AI routing
// policy (server/_shared/ai-routing-policy.ts) or an explicit provider name.
//
// Current models reject `temperature`, and thinking cannot be disabled on
// Claude Opus 5.5, so the adapter sends neither and controls depth with effort.
// Thinking tokens count against max_tokens, so the caller's visible-output
// budget gets fixed headroom on top; the prompts already bound answer length.

export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';
const THINKING_HEADROOM_TOKENS = 4_096;
// Server-side refusal fallback stays on Anthropic models, so it is policy-safe.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export type AnthropicEffort = 'low' | 'medium' | 'high';

export interface AnthropicChatMessage {
  role: string;
  content: string;
}

export interface AnthropicCompletion {
  content: string;
  finishReason: string | null;
  promptTokens: number;
  completionTokens: number;
}

export function getAnthropicApiKey(): string | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  return key ? key : null;
}

export function getAnthropicModel(enableReasoning: boolean): string {
  const reasoningModel = process.env.ANTHROPIC_REASONING_MODEL?.trim();
  if (enableReasoning && reasoningModel) return reasoningModel;
  return process.env.ANTHROPIC_MODEL?.trim() || ANTHROPIC_DEFAULT_MODEL;
}

/**
 * Split OpenAI-style chat messages into the Messages API shape: every system
 * message joins the top-level `system`, the rest keep their order.
 */
export function toAnthropicMessages(messages: AnthropicChatMessage[]): {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
} {
  const system: string[] = [];
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content) system.push(message.content);
      continue;
    }
    out.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content });
  }
  // The API requires the conversation to open with a user turn.
  if (out.length === 0 || out[0]!.role !== 'user') {
    out.unshift({ role: 'user', content: '(no input)' });
  }
  return { system: system.join('\n\n'), messages: out };
}

function createClient(apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    maxRetries: 0,
    fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
  });
}

function buildParams(opts: {
  model: string;
  messages: AnthropicChatMessage[];
  maxTokens: number;
  effort: AnthropicEffort;
}): Record<string, unknown> {
  const { system, messages } = toAnthropicMessages(opts.messages);
  return {
    model: opts.model,
    max_tokens: opts.maxTokens + THINKING_HEADROOM_TOKENS,
    ...(system ? { system } : {}),
    messages,
    output_config: { effort: opts.effort },
    fallbacks: 'default',
  };
}

function textOf(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim();
}

/**
 * Billed tokens for a response. With server-side fallback, every attempt
 * (the declined one included) is in `usage.iterations` and the top-level
 * counters cover only the attempt that answered — the same rule the relay
 * widget agent applies (scripts/ais-relay.cjs addUsage).
 */
export function anthropicBilledTokens(usage: unknown): { promptTokens: number; completionTokens: number } {
  const u = (usage ?? {}) as { input_tokens?: number; output_tokens?: number; iterations?: unknown };
  const parts = Array.isArray(u.iterations) && u.iterations.length > 0
    ? u.iterations as Array<{ input_tokens?: number; output_tokens?: number }>
    : [u];
  let promptTokens = 0;
  let completionTokens = 0;
  for (const part of parts) {
    promptTokens += part?.input_tokens ?? 0;
    completionTokens += part?.output_tokens ?? 0;
  }
  return { promptTokens, completionTokens };
}

export async function anthropicComplete(opts: {
  apiKey: string;
  model: string;
  messages: AnthropicChatMessage[];
  maxTokens: number;
  effort: AnthropicEffort;
  timeoutMs: number;
}): Promise<AnthropicCompletion> {
  const client = createClient(opts.apiKey);
  // `fallbacks` is newer than the SDK's request type; the relay widget agent
  // sends it the same way (scripts/ais-relay.cjs WIDGET_SONNET_PARAMS).
  const response = await client.messages.create(
    buildParams(opts) as unknown as Anthropic.MessageCreateParamsNonStreaming,
    { headers: { 'anthropic-beta': FALLBACK_BETA }, timeout: opts.timeoutMs },
  );
  const stopReason = response.stop_reason ?? null;
  return {
    content: stopReason === 'refusal' ? '' : textOf(response.content as Array<{ type: string; text?: string }>),
    finishReason: stopReason,
    ...anthropicBilledTokens(response.usage),
  };
}

/** Yields visible text deltas only; thinking deltas are dropped. */
export async function* anthropicStream(opts: {
  apiKey: string;
  model: string;
  messages: AnthropicChatMessage[];
  maxTokens: number;
  effort: AnthropicEffort;
  signal: AbortSignal;
  onAccepted?: () => void;
}): AsyncGenerator<string> {
  const client = createClient(opts.apiKey);
  const stream = client.messages.stream(
    buildParams(opts) as unknown as Anthropic.MessageStreamParams,
    { headers: { 'anthropic-beta': FALLBACK_BETA }, signal: opts.signal },
  );
  let accepted = false;
  for await (const event of stream) {
    if (!accepted && event.type === 'message_start') {
      accepted = true;
      opts.onAccepted?.();
    }
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield event.delta.text;
    }
    if (event.type === 'message_delta' && event.delta.stop_reason === 'refusal') {
      throw new AnthropicRefusalError();
    }
    // A token-limited answer is unfinished: throwing sends it down the
    // caller's truncated-stream path instead of a `done` event.
    if (event.type === 'message_delta' && event.delta.stop_reason === 'max_tokens') {
      throw new AnthropicIncompleteError();
    }
  }
}

/** HTTP status and a bounded message for an Anthropic API error, else null. */
export function getAnthropicErrorStatus(err: unknown): { status: number; body: string } | null {
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
    return { status: err.status, body: String(err.message ?? '').slice(0, 300) };
  }
  return null;
}

export class AnthropicIncompleteError extends Error {
  constructor() {
    super('Anthropic stopped at the token limit');
    this.name = 'AnthropicIncompleteError';
  }
}

export class AnthropicRefusalError extends Error {
  constructor() {
    super('Anthropic declined the request');
    this.name = 'AnthropicRefusalError';
  }
}
