/**
 * News service handler -- implements the generated NewsServiceHandler
 * interface with 2 RPCs:
 *   - ListNewsItems       (stub -- RSS fetching stays client-side for now)
 *   - SummarizeHeadlines  (Groq + OpenRouter LLM summarization)
 *
 * Consolidates legacy edge functions:
 *   api/groq-summarize.js
 *   api/openrouter-summarize.js
 *
 * ListNewsItems returns empty -- RSS feed parsing requires DOMParser
 * which is unavailable in edge runtime. Client-side rss.ts handles it.
 */

declare const process: { env: Record<string, string | undefined> };

import type {
  NewsServiceHandler,
  ServerContext,
  ListNewsItemsRequest,
  ListNewsItemsResponse,
  SummarizeHeadlinesRequest,
  SummarizeHeadlinesResponse,
  HeadlineSummary,
} from '../../../../../src/generated/server/worldmonitor/news/v1/service_server';

// ========================================================================
// Constants
// ========================================================================

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.1-8b-instant';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'openrouter/free';
const UPSTREAM_TIMEOUT_MS = 15_000;

// ========================================================================
// Headline deduplication
// ========================================================================

function deduplicateHeadlines(headlines: string[]): string[] {
  const seen: Set<string>[] = [];
  const unique: string[] = [];

  for (const headline of headlines) {
    const normalized = headline.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    const words = new Set(normalized.split(' ').filter((w) => w.length >= 4));

    let isDuplicate = false;
    for (const seenWords of seen) {
      const intersection = [...words].filter((w) => seenWords.has(w));
      const similarity = intersection.length / Math.min(words.size, seenWords.size);
      if (similarity > 0.6) { isDuplicate = true; break; }
    }

    if (!isDuplicate) {
      seen.push(words);
      unique.push(headline);
    }
  }

  return unique;
}

// ========================================================================
// LLM prompt builder
// ========================================================================

function buildPrompt(headlines: string[], topic: string): { system: string; user: string } {
  const uniqueHeadlines = deduplicateHeadlines(headlines.slice(0, 8));
  const headlineText = uniqueHeadlines.map((h, i) => `${i + 1}. ${h}`).join('\n');
  const dateContext = `Current date: ${new Date().toISOString().split('T')[0]}.`;

  const system = `${dateContext}

Summarize the key development in 2-3 sentences.
Rules:
- Lead with WHAT happened and WHERE - be specific
- NEVER start with "Breaking news", "Good evening", "Tonight", or TV-style openings
- Start directly with the subject
- No bullet points, no meta-commentary`;

  const user = topic
    ? `Summarize the top story about "${topic}":\n${headlineText}`
    : `Summarize the top story:\n${headlineText}`;

  return { system, user };
}

// ========================================================================
// Groq provider
// ========================================================================

async function tryGroq(
  headlines: string[],
  topic: string,
): Promise<HeadlineSummary | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  try {
    const { system, user } = buildPrompt(headlines, topic);
    const resp = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.3,
        max_tokens: 150,
        top_p: 0.9,
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    if (!resp.ok) return null;
    const data = await resp.json() as any;
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) return null;

    return {
      text,
      headlineCount: headlines.length,
      generatedAt: Date.now(),
      model: GROQ_MODEL,
    };
  } catch {
    return null;
  }
}

// ========================================================================
// OpenRouter provider
// ========================================================================

async function tryOpenRouter(
  headlines: string[],
  topic: string,
): Promise<HeadlineSummary | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  try {
    const { system, user } = buildPrompt(headlines, topic);
    const resp = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.3,
        max_tokens: 150,
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    if (!resp.ok) return null;
    const data = await resp.json() as any;
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) return null;

    return {
      text,
      headlineCount: headlines.length,
      generatedAt: Date.now(),
      model: OPENROUTER_MODEL,
    };
  } catch {
    return null;
  }
}

// ========================================================================
// Handler export
// ========================================================================

export const newsHandler: NewsServiceHandler = {
  async listNewsItems(
    _ctx: ServerContext,
    _req: ListNewsItemsRequest,
  ): Promise<ListNewsItemsResponse> {
    // RSS feed parsing requires DOMParser (browser-only).
    // Client-side rss.ts continues to handle this via proxy URLs.
    return { items: [], pagination: undefined };
  },

  async summarizeHeadlines(
    _ctx: ServerContext,
    req: SummarizeHeadlinesRequest,
  ): Promise<SummarizeHeadlinesResponse> {
    // This RPC is called by the service module for server-side summarization.
    // The client still has a browser T5 fallback if both providers fail.
    // The request doesn't carry headlines directly -- they come from the client.
    // For now, return empty (summarization stays client-side calling existing edge functions).
    // TODO: Once headline relay is implemented, consolidate here.
    return { summary: undefined };
  },
};
