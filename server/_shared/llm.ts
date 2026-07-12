import { CHROME_UA } from './constants';
import { isProviderAvailable } from './llm-health';
import { sanitizeForPrompt } from './llm-sanitize.js';
import { buildLlmCallEvent, deliverUsageEvents, type LlmCallEvent } from './usage';
import { getLlmAttemptTimeoutMs } from '../../scripts/_llm-model-timeouts.mjs';

export { getLlmAttemptTimeoutMs } from '../../scripts/_llm-model-timeouts.mjs';

function promptChars(messages: Array<{ role: string; content: string }>): number {
  return messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
}

// Best-effort, awaited: one POST per logical call (all provider attempts
// batched). deliverUsageEvents no-ops unless USAGE_TELEMETRY=1; awaiting a
// ≤1.5s-bounded telemetry write is noise next to a multi-second completion
// and survives Edge isolate teardown (no dangling promise).
async function flushLlmEvents(events: LlmCallEvent[]): Promise<void> {
  if (events.length === 0) return;
  try {
    await deliverUsageEvents(events);
  } catch { /* telemetry must never affect the call result */ }
}

export interface ProviderCredentials {
  apiUrl: string;
  model: string;
  headers: Record<string, string>;
  extraBody?: Record<string, unknown>;
}

export type LlmProviderName = 'ollama' | 'groq' | 'openrouter' | 'generic';

export interface ProviderCredentialOverrides {
  model?: string;
  /** OpenRouter only: let reasoning-capable models reason (reasoning profile). Default false — utility calls must not pay reasoning tokens. */
  enableReasoning?: boolean;
}

const OLLAMA_HOST_ALLOWLIST = new Set([
  'localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal',
]);

function isLocalDeployment(): boolean {
  const mode = typeof process !== 'undefined' ? (process.env?.LOCAL_API_MODE || '') : '';
  return mode.includes('sidecar') || mode.includes('docker');
}

// OpenRouter provider routing. WorldMonitor is a geopolitical product, so
// inference must never physically run on a China-hosted provider — one could
// log queries or bias outputs on the exact topics we cover (Taiwan, Xinjiang,
// the South China Sea, etc.). We BLOCK the known China-based providers and let
// OpenRouter serve the model (DeepSeek weights are fine; hosting is the
// concern) from the fastest of the rest.
//   - `ignore`: blocklist. These MUST be OpenRouter's lowercase provider
//     SLUGS (from GET /api/v1/providers), NOT display names — OpenRouter
//     silently drops unrecognized entries, so a display name like "DeepSeek"
//     matches nothing and the block is a no-op (caught in #4993 review).
//     Verified against /providers 2026-07-07. RE-AUDIT periodically — a new
//     China-based entrant would otherwise be eligible.
//   - `sort: throughput`: also steers off OpenRouter's cheapest-but-slowest
//     default (DeepInfra ~17 tok/s) to the fastest eligible provider, which is
//     the brief-latency win we were chasing (#4983 follow-up).
const OPENROUTER_BLOCKED_PROVIDERS = [
  'baidu', 'alibaba', 'deepseek', 'siliconflow', 'streamlake', 'novita',
];
const OPENROUTER_PROVIDER_ROUTING = {
  ignore: OPENROUTER_BLOCKED_PROVIDERS,
  sort: 'throughput',
} as const;

export function getProviderCredentials(
  provider: string,
  overrides: ProviderCredentialOverrides = {},
): ProviderCredentials | null {
  if (provider === 'ollama') {
    const baseUrl = process.env.OLLAMA_API_URL;
    if (!baseUrl) return null;

    if (!isLocalDeployment()) {
      try {
        const hostname = new URL(baseUrl).hostname;
        if (!OLLAMA_HOST_ALLOWLIST.has(hostname)) {
          console.warn(`[llm] Ollama blocked: hostname "${hostname}" not in allowlist`);
          return null;
        }
      } catch {
        return null;
      }
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const apiKey = process.env.OLLAMA_API_KEY;
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    return {
      apiUrl: new URL('/v1/chat/completions', baseUrl).toString(),
      model: overrides.model || process.env.OLLAMA_MODEL || 'llama3.1:8b',
      headers,
      extraBody: { think: false },
    };
  }

  if (provider === 'groq') {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return null;
    return {
      apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
      model: overrides.model || 'llama-3.3-70b-versatile',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    };
  }

  if (provider === 'openrouter') {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return null;
    return {
      apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
      model: overrides.model || 'deepseek/deepseek-v4-flash',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://worldmonitor.app',
        'X-Title': 'World Monitor',
      },
      // Hybrid-reasoning models (DeepSeek V4) reason by default via
      // OpenRouter's normalized `reasoning` param; utility calls must not
      // pay reasoning tokens. The reasoning profile opts back in, letting
      // the model's own default apply. `provider` routing is always sent —
      // the China-provider exclusion is not optional (see the constant).
      extraBody: {
        ...(overrides.enableReasoning ? {} : { reasoning: { enabled: false } }),
        provider: OPENROUTER_PROVIDER_ROUTING,
      },
    };
  }

  // Generic OpenAI-compatible endpoint via LLM_API_URL/LLM_API_KEY/LLM_MODEL
  if (provider === 'generic') {
    const apiUrl = process.env.LLM_API_URL;
    const apiKey = process.env.LLM_API_KEY;
    if (!apiUrl || !apiKey) return null;
    return {
      apiUrl,
      model: overrides.model || process.env.LLM_MODEL || 'gpt-3.5-turbo',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    };
  }

  return null;
}

/**
 * Read AT MOST ~`cap` characters of a provider error body, then cancel the
 * stream — a large or slow error body must never delay the next-provider
 * fallback (#4966 review). The request's own AbortSignal still bounds a
 * pathological first-chunk stall.
 */
async function readBoundedErrorBody(resp: Response, cap: number): Promise<string> {
  const body = resp.body;
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  try {
    while (out.length < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
  } catch { /* best-effort diagnostics only */ } finally {
    try { void reader.cancel(); } catch { /* already closed */ }
  }
  return out.slice(0, cap);
}

export function stripThinkingTags(text: string): string {
  let s = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/<reflection>[\s\S]*?<\/reflection>/gi, '')
    .replace(/<\|begin_of_thought\|>[\s\S]*?<\|end_of_thought\|>/gi, '')
    .trim();

  // Strip unterminated opening tags (no closing tag present)
  s = s
    .replace(/<think>[\s\S]*/gi, '')
    .replace(/<\|thinking\|>[\s\S]*/gi, '')
    .replace(/<reasoning>[\s\S]*/gi, '')
    .replace(/<reflection>[\s\S]*/gi, '')
    .replace(/<\|begin_of_thought\|>[\s\S]*/gi, '')
    .trim();

  return s;
}


// openrouter ahead of groq since #4944: core surfaces run DeepSeek V4 Flash
// via OpenRouter; groq (llama-3.3-70b-versatile) is the free-tier/outage
// fallback. Ollama stays first so self-hosted deployments are untouched —
// it is skipped in cloud where OLLAMA_API_URL is unset.
const PROVIDER_CHAIN = ['ollama', 'openrouter', 'groq', 'generic'] as const;
const PROVIDER_SET = new Set<string>(PROVIDER_CHAIN);

export interface LlmCallOptions {
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  provider?: string;
  // Optional overrides. When omitted, the historic provider chain and default
  // provider models remain unchanged for all existing callers.
  providerOrder?: string[];
  modelOverrides?: Partial<Record<LlmProviderName, string>>;
  stripThinkingTags?: boolean;
  validate?: (content: string) => boolean;
  /** Optional text to append to the system message (index 0). Appended as \n\n---\n\n<systemAppend>. No-op if no system message at index 0. */
  systemAppend?: string;
  /** Caller surface tag for llm_call usage telemetry (e.g. 'classify-event'). */
  stage?: string;
  /** Let reasoning-capable OpenRouter models reason. Set by the reasoning profile; utility calls stay reasoning-off. */
  enableReasoning?: boolean;
  /**
   * Treat provider-reported token-limit completions as failed attempts and
   * continue the configured provider chain. Defaults off so existing callers
   * retain the historic first-non-empty-completion behavior.
   */
  retryOnLengthLimit?: boolean;
}

export interface LlmCallResult {
  content: string;
  model: string;
  provider: string;
  tokens: number;
  /** Provider-reported completion status; null when the provider omits it. */
  finishReason: string | null;
}

const TOKEN_LIMIT_FINISH_REASONS = new Set([
  'length',
  'max_tokens',
  'max_output_tokens',
]);

const KNOWN_NON_LIMIT_FINISH_REASONS = new Set([
  'stop',
  'end_turn',
  'tool_calls',
  'function_call',
  'content_filter',
  'safety',
  'recitation',
  'blocklist',
  'prohibited_content',
  'spii',
  'malformed_function_call',
  'image_safety',
]);

function normalizeFinishReason(finishReason: string | null): string | null {
  if (typeof finishReason !== 'string') return null;
  const normalized = finishReason.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return normalized || null;
}

function isLengthLimitedCompletion(
  finishReason: string | null,
  completionTokens: number,
  maxTokens: number,
): boolean {
  const normalized = normalizeFinishReason(finishReason);
  if (normalized && TOKEN_LIMIT_FINISH_REASONS.has(normalized)) return true;
  if (completionTokens < maxTokens) return false;
  return normalized === null || !KNOWN_NON_LIMIT_FINISH_REASONS.has(normalized);
}

function resolveProviderChain(opts: {
  forcedProvider?: string;
  providerOrder?: string[];
}): string[] {
  if (opts.forcedProvider) return [opts.forcedProvider];
  if (!Array.isArray(opts.providerOrder) || opts.providerOrder.length === 0) {
    return [...PROVIDER_CHAIN];
  }

  const seen = new Set<string>();
  const providers: string[] = [];
  for (const provider of opts.providerOrder) {
    if (!PROVIDER_SET.has(provider) || seen.has(provider)) continue;
    seen.add(provider);
    providers.push(provider);
  }

  return providers.length > 0 ? providers : [...PROVIDER_CHAIN];
}

function callLlmProfile(
  opts: Omit<LlmCallOptions, 'providerOrder' | 'modelOverrides'>,
  providerEnv: string,
  modelEnv: string,
  defaultProvider: LlmProviderName,
): Promise<LlmCallResult | null> {
  const envProvider = process.env[providerEnv];
  const provider = (envProvider && PROVIDER_SET.has(envProvider) ? envProvider : (() => {
    if (envProvider) console.warn(`[llm] ${providerEnv}="${envProvider}" is not a known provider; falling back to "${defaultProvider}"`);
    return defaultProvider;
  })()) as LlmProviderName;
  const model = process.env[modelEnv];
  const remaining = PROVIDER_CHAIN.filter((p) => p !== provider);
  return callLlm({
    ...opts,
    providerOrder: [provider, ...remaining],
    modelOverrides: model ? { [provider]: model } as Partial<Record<LlmProviderName, string>> : undefined,
  });
}

/** Cheap/fast model for extraction and parsing tasks. Configurable via LLM_TOOL_PROVIDER / LLM_TOOL_MODEL. */
export const callLlmTool = (opts: Omit<LlmCallOptions, 'providerOrder' | 'modelOverrides'>) =>
  callLlmProfile(opts, 'LLM_TOOL_PROVIDER', 'LLM_TOOL_MODEL', 'groq');

/**
 * Powerful model for synthesis and reasoning tasks. Configurable via
 * LLM_REASONING_PROVIDER / LLM_REASONING_MODEL. Reasoning is ON by default,
 * but a caller may pass `enableReasoning: false` to use the same
 * high-quality model with reasoning DISABLED — required for short-output
 * stages (a 2–3 sentence brief blurb) where an actual reasoning model
 * (e.g. deepseek-v4-pro) would otherwise spend its whole small max_tokens
 * budget on hidden reasoning tokens and return empty content (#4983).
 */
export const callLlmReasoning = (opts: Omit<LlmCallOptions, 'providerOrder' | 'modelOverrides'>) =>
  callLlmProfile({ enableReasoning: true, ...opts }, 'LLM_REASONING_PROVIDER', 'LLM_REASONING_MODEL', 'openrouter');

// enableReasoning is omitted too: the reasoning stream hardcodes it on —
// exposing the knob on the stream type would be a silent no-op for callers.
export type LlmStreamOptions = Omit<LlmCallOptions, 'stripThinkingTags' | 'validate' | 'providerOrder' | 'modelOverrides' | 'provider' | 'enableReasoning' | 'retryOnLengthLimit'> & {
  /** When fired, aborts the active provider fetch and stops the stream. */
  signal?: AbortSignal;
};

/**
 * Streaming variant of callLlmReasoning.
 * Returns a ReadableStream that emits SSE lines:
 *   data: {"delta":"..."}  — one per content chunk
 *   data: {"done":true}    — terminal event
 * Returns null if no provider is available.
 */
export function callLlmReasoningStream(opts: LlmStreamOptions): ReadableStream<Uint8Array> {
  const envProvider = process.env.LLM_REASONING_PROVIDER;
  const provider = (envProvider && PROVIDER_SET.has(envProvider) ? envProvider : 'openrouter') as LlmProviderName;
  const model = process.env.LLM_REASONING_MODEL;
  const remaining = PROVIDER_CHAIN.filter((p) => p !== provider);
  const providerOrder = [provider, ...remaining];
  const modelOverrides = model ? { [provider]: model } as Partial<Record<LlmProviderName, string>> : undefined;

  const {
    messages: rawMessages,
    temperature = 0.3,
    maxTokens = 600,
    timeoutMs = 90_000,
    systemAppend,
    signal: clientSignal,
  } = opts;

  let messages = rawMessages;
  const firstMsg = messages[0];
  if (systemAppend && firstMsg?.role === 'system') {
    const sanitized = sanitizeForPrompt(systemAppend);
    if (sanitized) {
      messages = [
        { role: 'system', content: `${firstMsg.content}\n\n---\n\n${sanitized}` },
        ...messages.slice(1),
      ];
    }
  }

  const enc = new TextEncoder();
  let activeController: AbortController | null = null;
  let streamClosed = false;
  const stage = opts.stage || 'unknown';
  const inputChars = promptChars(messages);
  const events: LlmCallEvent[] = [];
  let attemptIndex = 0;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (obj: Record<string, unknown>) => {
        if (streamClosed) return;
        controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      const closeStream = () => {
        if (streamClosed) return;
        streamClosed = true;
        controller.close();
      };
      // Flush AFTER the stream is closed so telemetry latency never delays
      // the client's terminal event. Token counts are unavailable on the SSE
      // path — prompt_chars + duration still attribute the spend surface.
      const closeAndFlush = async () => {
        closeStream();
        await flushLlmEvents(events);
      };

      for (const providerName of providerOrder) {
        if (streamClosed) break;

        const creds = getProviderCredentials(providerName, {
          model: modelOverrides?.[providerName as LlmProviderName],
          // Streaming variant of callLlmReasoning — the reasoning profile opts in.
          enableReasoning: true,
        });
        if (!creds) continue;

        if (!(await isProviderAvailable(creds.apiUrl))) {
          console.warn(`[llm-stream:${providerName}] Offline, skipping`);
          continue;
        }

        // Per-fetch abort controller merges client signal + per-request timeout
        activeController = new AbortController();
        const timeoutId = setTimeout(() => activeController?.abort(), timeoutMs);
        if (clientSignal?.aborted) { clearTimeout(timeoutId); break; }
        clientSignal?.addEventListener('abort', () => activeController?.abort(), { once: true });

        const t0 = Date.now();
        const fallbackIndex = attemptIndex;
        attemptIndex += 1;
        const record = (ok: boolean, reason = '') => {
          events.push(buildLlmCallEvent({
            provider: providerName,
            model: creds.model,
            stage,
            ok,
            durationMs: Date.now() - t0,
            promptChars: inputChars,
            maxTokens,
            fallbackIndex,
            reason,
          }));
        };

        let hasContent = false;
        try {
          const resp = await fetch(creds.apiUrl, {
            method: 'POST',
            headers: { ...creds.headers, 'User-Agent': CHROME_UA },
            body: JSON.stringify({
              ...creds.extraBody,
              model: creds.model,
              messages,
              temperature,
              max_tokens: maxTokens,
              stream: true,
            }),
            signal: activeController.signal,
          });
          // Timeout stays active — it must bound the streaming body read, not just the connection

          if (!resp.ok || !resp.body) {
            clearTimeout(timeoutId);
            const errBody = resp.body ? await resp.text().catch(() => '') : '';
            console.warn(`[llm-stream:${providerName}] HTTP ${resp.status} model=${creds.model} body=${errBody.slice(0, 300)}`);
            record(false, `http_${resp.status}`);
            continue;
          }

          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          let providerDone = false;

          while (!streamClosed && !providerDone) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const payload = line.slice(6).trim();
              if (payload === '[DONE]') { providerDone = true; break; }
              try {
                const chunk = JSON.parse(payload) as {
                  choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
                };
                const delta = chunk.choices?.[0]?.delta?.content;
                if (delta) {
                  hasContent = true;
                  emit({ delta });
                }
              } catch { /* malformed chunk — skip */ }
            }
          }
          clearTimeout(timeoutId);

          if (hasContent) {
            record(true);
            emit({ done: true });
            await closeAndFlush();
            return;
          }
          record(false, 'empty');
        } catch (err) {
          clearTimeout(timeoutId);
          if (hasContent) {
            // Partial stream — close without done so the client sees it as truncated, not success
            record(false, 'truncated');
            await closeAndFlush();
            return;
          }
          if (streamClosed) { await flushLlmEvents(events); return; }
          console.warn(`[llm-stream:${providerName}] ${(err as Error).message}`);
          const name = (err as Error).name;
          record(false, name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'fetch_error');
        }
      }

      if (!streamClosed) {
        emit({ error: 'llm_unavailable' });
      }
      await closeAndFlush();
    },
    cancel() {
      // Client disconnected — abort the active provider fetch immediately
      streamClosed = true;
      activeController?.abort();
    },
  });
}

export async function callLlm(opts: LlmCallOptions): Promise<LlmCallResult | null> {
  const {
    messages: rawMessages,
    temperature = 0.3,
    maxTokens = 1500,
    timeoutMs = 25_000,
    provider: forcedProvider,
    providerOrder,
    modelOverrides,
    stripThinkingTags: shouldStrip = true,
    validate,
    systemAppend,
    enableReasoning = false,
    retryOnLengthLimit = false,
  } = opts;

  let messages = rawMessages;
  const firstMsg = messages[0];
  if (systemAppend && firstMsg && firstMsg.role === 'system') {
    const sanitized = sanitizeForPrompt(systemAppend);
    if (sanitized) {
      messages = [
        { role: 'system', content: `${firstMsg.content}\n\n---\n\n${sanitized}` },
        ...messages.slice(1),
      ];
    }
  }

  const providers = resolveProviderChain({ forcedProvider, providerOrder });
  const stage = opts.stage || 'unknown';
  const inputChars = promptChars(messages);
  const events: LlmCallEvent[] = [];
  let attemptIndex = 0;

  try {
    for (const providerName of providers) {
      const creds = getProviderCredentials(providerName, {
        model: modelOverrides?.[providerName as LlmProviderName],
        enableReasoning,
      });
      if (!creds) {
        if (forcedProvider) return null;
        continue;
      }

      // Health gate: skip provider if endpoint is unreachable
      if (!(await isProviderAvailable(creds.apiUrl))) {
        console.warn(`[llm:${providerName}] Offline, skipping`);
        if (forcedProvider) return null;
        continue;
      }

      // Skipped providers (no creds / offline) never sent the prompt, so
      // only real attempts get an event and advance the fallback index.
      const t0 = Date.now();
      const fallbackIndex = attemptIndex;
      attemptIndex += 1;
      const record = (ok: boolean, extra: { reason?: string; tokensTotal?: number; tokensPrompt?: number; tokensCompletion?: number } = {}) => {
        events.push(buildLlmCallEvent({
          provider: providerName,
          model: creds.model,
          stage,
          ok,
          durationMs: Date.now() - t0,
          promptChars: inputChars,
          maxTokens,
          fallbackIndex,
          ...extra,
        }));
      };

      try {
        const resp = await fetch(creds.apiUrl, {
          method: 'POST',
          headers: { ...creds.headers, 'User-Agent': CHROME_UA },
          body: JSON.stringify({
            ...creds.extraBody,
            model: creds.model,
            messages,
            temperature,
            max_tokens: maxTokens,
          }),
          // #5246: DeepSeek V4 Flash is bimodal — healthy calls finish near 2s,
          // while stalled calls hang to the old 25s clamp. Cut only this model's
          // dead tail so the existing provider chain can reach its fallback.
          signal: AbortSignal.timeout(getLlmAttemptTimeoutMs(creds.model, timeoutMs)),
        });

        if (!resp.ok) {
          // Log a bounded body slice (like the stream path already does) —
          // region-403s and provider errors are undiagnosable from the
          // status code alone (#4944 U7). Bounded READ, not just bounded
          // log: never consume a huge/slow error body before falling back.
          const errBody = await readBoundedErrorBody(resp, 300).catch(() => '');
          console.warn(`[llm:${providerName}] HTTP ${resp.status} model=${creds.model} body=${errBody}`);
          record(false, { reason: `http_${resp.status}` });
          if (forcedProvider) return null;
          continue;
        }

        const data = (await resp.json()) as {
          choices?: Array<{ message?: { content?: string }; finish_reason?: string | null }>;
          usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
        };
        const tokensExtra = {
          tokensTotal: data.usage?.total_tokens ?? 0,
          tokensPrompt: data.usage?.prompt_tokens ?? 0,
          tokensCompletion: data.usage?.completion_tokens ?? 0,
        };

        const tokens = data.usage?.total_tokens ?? 0;
        const finishReason = typeof data.choices?.[0]?.finish_reason === 'string'
          ? data.choices[0].finish_reason
          : null;
        if (retryOnLengthLimit && isLengthLimitedCompletion(
          finishReason,
          tokensExtra.tokensCompletion,
          maxTokens,
        )) {
          console.warn(`[llm:${providerName}] Token-limited completion, trying next`);
          record(false, { ...tokensExtra, reason: 'length' });
          if (forcedProvider) return null;
          continue;
        }

        let content = data.choices?.[0]?.message?.content?.trim() || '';
        if (!content) {
          record(false, { ...tokensExtra, reason: 'empty' });
          if (forcedProvider) return null;
          continue;
        }

        if (shouldStrip) {
          content = stripThinkingTags(content);
          if (!content) {
            record(false, { ...tokensExtra, reason: 'stripped_empty' });
            if (forcedProvider) return null;
            continue;
          }
        }

        // Strip markdown code fences (e.g. ```json ... ```) that some models add
        content = content.replace(/^```(?:\w+)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();

        if (validate && !validate(content)) {
          console.warn(`[llm:${providerName}] validate() rejected response, trying next`);
          record(false, { ...tokensExtra, reason: 'validate_reject' });
          if (forcedProvider) return null;
          continue;
        }

        record(true, tokensExtra);
        return { content, model: creds.model, provider: providerName, tokens, finishReason };
      } catch (err) {
        const name = (err as Error).name;
        console.warn(`[llm:${providerName}] ${(err as Error).message}`);
        record(false, { reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'fetch_error' });
        if (forcedProvider) return null;
      }
    }

    return null;
  } finally {
    await flushLlmEvents(events);
  }
}
