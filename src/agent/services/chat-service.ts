/**
 * Chat Service — Streaming LLM client for Agent UI.
 * Supports: Ollama (local), Groq (cloud), OpenRouter (cloud), Custom API.
 * Custom API: Anthropic /v1/messages + x-api-key (confirmed working on duojie.games).
 * Other providers: OpenAI-compatible /v1/chat/completions + Authorization: Bearer.
 */

import type { ChatMessage, AgentSettings } from './conversation-store';
import { fetchNewsContext } from './news-context';

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: string) => void;
  onSearch?: (status: 'searching' | 'done', resultCount?: number) => void;
}

// ── Helpers ──

function getSystemPrompt(systemPrompt: string, toolMode?: string): string {
  let system = systemPrompt;
  if (toolMode === 'deep-think') {
    system += '\n\nIMPORTANT: Think step by step. Show your reasoning process clearly. Break down complex problems into smaller parts.';
  } else if (toolMode === 'research') {
    system += '\n\nIMPORTANT: Provide in-depth research-level analysis. Cite sources when possible. Cover multiple perspectives and provide comprehensive analysis.';
  } else if (toolMode === 'code') {
    system += '\n\nIMPORTANT: Focus on code generation and technical solutions. Use code blocks with language annotations. Explain the code clearly.';
  } else if (toolMode === 'intel') {
    system += '\n\nIMPORTANT: Focus on intelligence analysis, geopolitical implications, and threat assessment. Use OSINT methodology.';
  } else if (toolMode === 'market') {
    system += '\n\nIMPORTANT: Focus on market analysis, financial implications, and economic indicators. Provide data-driven insights.';
  }
  return system;
}

// ── Abort ──

let activeController: AbortController | null = null;

export function abortChat(): void {
  if (activeController) {
    activeController.abort();
    activeController = null;
  }
}

// ── Main entry ──

export async function streamChat(
  messages: ChatMessage[],
  settings: AgentSettings,
  toolMode: string | undefined,
  callbacks: StreamCallbacks,
): Promise<void> {
  abortChat();
  activeController = new AbortController();
  const { signal } = activeController;

  try {
    if (settings.provider === 'custom') {
      // All custom models use /v1/chat/completions + Authorization: Bearer
      // (claude-opus-4-6-max /v1/messages streaming returns 503 upstream failures)
      await streamCustomOpenAI(messages, settings, toolMode, callbacks, signal);
    } else {
      await streamOpenAI(messages, settings, toolMode, callbacks, signal);
    }
  } finally {
    activeController = null;
  }
}

// ── Custom provider OpenAI-compatible (/v1/chat/completions + Bearer) ──

async function streamCustomOpenAI(
  messages: ChatMessage[],
  settings: AgentSettings,
  toolMode: string | undefined,
  callbacks: StreamCallbacks,
  signal: AbortSignal,
): Promise<void> {
  const baseUrl = (settings.customBaseUrl || 'https://api.duojie.games').replace(/\/+$/, '');
  const model = (settings.customModel || 'claude-sonnet-4-6').trim();
  const apiKey = (settings.customApiKey || '').trim();
  let system = getSystemPrompt(settings.systemPrompt, toolMode);

  // Fetch real-time web search context
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  callbacks.onSearch?.('searching');
  const newsCtx = await fetchNewsContext(lastUserMsg).catch(() => null);
  const resultCount = newsCtx ? (newsCtx.match(/^•/gm) || []).length : 0;
  callbacks.onSearch?.('done', resultCount);
  if (newsCtx) system = `${system}\n\n${newsCtx}`;

  const chatMessages: Array<{ role: string; content: string }> = [
    { role: 'system', content: system },
    ...messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content })),
  ];

  const body = { model, messages: chatMessages, stream: true, temperature: settings.temperature, max_tokens: 4096 };

  const targetUrl = `${baseUrl}/v1/chat/completions`;
  const isDevMode = typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

  let fetchUrl = targetUrl;
  const fetchHeaders: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (isDevMode) {
    fetchUrl = '/api/llm-proxy';
    fetchHeaders['X-Target-URL'] = targetUrl;
  }

  let fullText = '';
  try {
    const response = await fetch(fetchUrl, { method: 'POST', headers: fetchHeaders, body: JSON.stringify(body), signal });
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 300)}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') { callbacks.onDone(fullText); return; }
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) { fullText += delta; callbacks.onToken(delta); }
        } catch { /* skip */ }
      }
    }
    callbacks.onDone(fullText);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      callbacks.onDone(fullText);
    } else {
      callbacks.onError(err instanceof Error ? err.message : String(err));
    }
  }
}

// ── OpenAI-compatible (/v1/chat/completions) ──

async function streamOpenAI(
  messages: ChatMessage[],
  settings: AgentSettings,
  toolMode: string | undefined,
  callbacks: StreamCallbacks,
  signal: AbortSignal,
): Promise<void> {
  let system = getSystemPrompt(settings.systemPrompt, toolMode);

  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  callbacks.onSearch?.('searching');
  const newsCtx = await fetchNewsContext(lastUserMsg).catch(() => null);
  const resultCount = newsCtx ? (newsCtx.match(/^•/gm) || []).length : 0;
  callbacks.onSearch?.('done', resultCount);
  if (newsCtx) system = `${system}\n\n${newsCtx}`;

  // Build messages array with system role
  const chatMessages: Array<{ role: string; content: string }> = [
    { role: 'system', content: system },
  ];
  for (const msg of messages) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      chatMessages.push({ role: msg.role, content: msg.content });
    }
  }

  // Provider-specific config
  let url: string;
  let model: string;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (settings.provider === 'ollama') {
    const baseUrl = settings.ollamaUrl || 'http://localhost:11434';
    url = `${baseUrl}/v1/chat/completions`;
    model = settings.ollamaModel || 'llama3.1:8b';
  } else if (settings.provider === 'groq') {
    url = 'https://api.groq.com/openai/v1/chat/completions';
    model = 'llama-3.1-8b-instant';
    headers['Authorization'] = `Bearer ${settings.groqKey}`;
  } else if (settings.provider === 'openrouter') {
    url = 'https://openrouter.ai/api/v1/chat/completions';
    model = 'openrouter/auto';
    headers['Authorization'] = `Bearer ${settings.openrouterKey}`;
    headers['HTTP-Referer'] = 'https://worldmonitor.app';
    headers['X-Title'] = 'WorldMonitor Agent';
  } else {
    // Fallback — should not reach here for 'custom' provider
    url = 'https://api.groq.com/openai/v1/chat/completions';
    model = 'llama-3.1-8b-instant';
  }

  const body = {
    model,
    messages: chatMessages,
    stream: true,
    temperature: settings.temperature,
    max_tokens: 4096,
  };

  let fetchUrl = url;
  const fetchHeaders = { ...headers };

  let fullText = '';

  try {
    const response = await fetch(fetchUrl, {
      method: 'POST',
      headers: fetchHeaders,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 300)}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          callbacks.onDone(fullText);
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            callbacks.onToken(delta);
          }
        } catch {
          // Skip malformed JSON chunks
        }
      }
    }

    callbacks.onDone(fullText);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      callbacks.onDone(fullText);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      callbacks.onError(message);
    }
  }
}

/**
 * Fetch available models from Ollama instance.
 */
export async function fetchOllamaModels(baseUrl: string): Promise<string[]> {
  try {
    const resp = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.models || [])
      .map((m: { name: string }) => m.name)
      .filter((name: string) => !name.includes('embed'));
  } catch {
    return [];
  }
}
