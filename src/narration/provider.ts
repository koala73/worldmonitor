import type { AIProviderConfig, ChatMessage } from '@/types/news-reader';

export interface AIResponse {
  content: string;
  tokensUsed: number;
}

export async function callAI(
  config: AIProviderConfig,
  messages: ChatMessage[],
  maxTokens?: number,
): Promise<AIResponse> {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  // OpenRouter requires extra headers
  if (config.provider === 'openrouter') {
    headers['HTTP-Referer'] = window.location.origin;
    headers['X-Title'] = 'WorldMonitor Reader';
  }

  const body = {
    model: config.model,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    max_tokens: maxTokens || config.maxTokens,
    temperature: 0.3,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`AI API error ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { total_tokens?: number; completion_tokens?: number };
  };

  const content = data.choices?.[0]?.message?.content || '';
  const tokensUsed = data.usage?.total_tokens ?? data.usage?.completion_tokens ?? estimateTokens(content);

  return { content: content.trim(), tokensUsed };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).length * 1.3);
}

export async function testConnection(config: AIProviderConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    const result = await callAI(config, [
      { role: 'system', content: 'Respond with exactly: OK' },
      { role: 'user', content: 'Test' },
    ], 10);
    return { ok: result.content.toLowerCase().includes('ok') };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}
