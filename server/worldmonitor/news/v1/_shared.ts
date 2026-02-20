declare const process: { env: Record<string, string | undefined> };

import type {
  HeadlineSummary,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';

// ========================================================================
// Constants
// ========================================================================

export const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const GROQ_MODEL = 'llama-3.1-8b-instant';
export const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const OPENROUTER_MODEL = 'openrouter/free';
export const UPSTREAM_TIMEOUT_MS = 15_000;

export const CACHE_TTL_SECONDS = 86400; // 24 hours
export const CACHE_VERSION = 'v3';

// ========================================================================
// Hash utility (unified FNV-1a 52-bit — H-7 fix)
// ========================================================================

export { hashString } from '../../../_shared/hash';

// ========================================================================
// Cache key builder (ported from _summarize-handler.js)
// ========================================================================

export function getCacheKey(
  headlines: string[],
  mode: string,
  geoContext: string = '',
  variant: string = 'full',
  lang: string = 'en',
): string {
  const sorted = headlines.slice(0, 8).sort().join('|');
  const geoHash = geoContext ? ':g' + hashString(geoContext).slice(0, 6) : '';
  const hash = hashString(`${mode}:${sorted}`);
  const normalizedVariant = typeof variant === 'string' && variant ? variant.toLowerCase() : 'full';
  const normalizedLang = typeof lang === 'string' && lang ? lang.toLowerCase() : 'en';

  if (mode === 'translate') {
    const targetLang = normalizedVariant || normalizedLang;
    return `summary:${CACHE_VERSION}:${mode}:${targetLang}:${hash}${geoHash}`;
  }

  return `summary:${CACHE_VERSION}:${mode}:${normalizedVariant}:${normalizedLang}:${hash}${geoHash}`;
}

// ========================================================================
// Headline deduplication (shared by SummarizeHeadlines + SummarizeArticle)
// ========================================================================

export function deduplicateHeadlines(headlines: string[]): string[] {
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
// SummarizeHeadlines: LLM prompt builder
// ========================================================================

export function buildPrompt(headlines: string[], topic: string): { system: string; user: string } {
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
// SummarizeArticle: Full prompt builder (ported from _summarize-handler.js)
// ========================================================================

export function buildArticlePrompts(
  headlines: string[],
  uniqueHeadlines: string[],
  opts: { mode: string; geoContext: string; variant: string; lang: string },
): { systemPrompt: string; userPrompt: string } {
  const headlineText = uniqueHeadlines.map((h, i) => `${i + 1}. ${h}`).join('\n');
  const intelSection = opts.geoContext ? `\n\n${opts.geoContext}` : '';
  const isTechVariant = opts.variant === 'tech';
  const dateContext = `Current date: ${new Date().toISOString().split('T')[0]}.${isTechVariant ? '' : ' Donald Trump is the current US President (second term, inaugurated Jan 2025).'}`;
  const langInstruction = opts.lang && opts.lang !== 'en' ? `\nIMPORTANT: Output the summary in ${opts.lang.toUpperCase()} language.` : '';

  let systemPrompt: string;
  let userPrompt: string;

  if (opts.mode === 'brief') {
    if (isTechVariant) {
      systemPrompt = `${dateContext}

Summarize the key tech/startup development in 2-3 sentences.
Rules:
- Focus ONLY on technology, startups, AI, funding, product launches, or developer news
- IGNORE political news, trade policy, tariffs, government actions unless directly about tech regulation
- Lead with the company/product/technology name
- Start directly: "OpenAI announced...", "A new $50M Series B...", "GitHub released..."
- No bullet points, no meta-commentary${langInstruction}`;
    } else {
      systemPrompt = `${dateContext}

Summarize the key development in 2-3 sentences.
Rules:
- Lead with WHAT happened and WHERE - be specific
- NEVER start with "Breaking news", "Good evening", "Tonight", or TV-style openings
- Start directly with the subject: "Iran's regime...", "The US Treasury...", "Protests in..."
- CRITICAL FOCAL POINTS are the main actors - mention them by name
- If focal points show news + signals convergence, that's the lead
- No bullet points, no meta-commentary${langInstruction}`;
    }
    userPrompt = `Summarize the top story:\n${headlineText}${intelSection}`;
  } else if (opts.mode === 'analysis') {
    if (isTechVariant) {
      systemPrompt = `${dateContext}

Analyze the tech/startup trend in 2-3 sentences.
Rules:
- Focus ONLY on technology implications: funding trends, AI developments, market shifts, product strategy
- IGNORE political implications, trade wars, government unless directly about tech policy
- Lead with the insight for tech industry
- Connect to startup ecosystem, VC trends, or technical implications`;
    } else {
      systemPrompt = `${dateContext}

Provide analysis in 2-3 sentences. Be direct and specific.
Rules:
- Lead with the insight - what's significant and why
- NEVER start with "Breaking news", "Tonight", "The key/dominant narrative is"
- Start with substance: "Iran faces...", "The escalation in...", "Multiple signals suggest..."
- CRITICAL FOCAL POINTS are your main actors - explain WHY they matter
- If focal points show news-signal correlation, flag as escalation
- Connect dots, be specific about implications`;
    }
    userPrompt = isTechVariant
      ? `What's the key tech trend or development?\n${headlineText}${intelSection}`
      : `What's the key pattern or risk?\n${headlineText}${intelSection}`;
  } else if (opts.mode === 'translate') {
    const targetLang = opts.variant;
    systemPrompt = `You are a professional news translator. Translate the following news headlines/summaries into ${targetLang}.
Rules:
- Maintain the original tone and journalistic style.
- Do NOT add any conversational filler (e.g., "Here is the translation").
- Output ONLY the translated text.
- If the text is already in ${targetLang}, return it as is.`;
    userPrompt = `Translate to ${targetLang}:\n${headlines[0]}`;
  } else {
    systemPrompt = isTechVariant
      ? `${dateContext}\n\nSynthesize tech news in 2 sentences. Focus on startups, AI, funding, products. Ignore politics unless directly about tech regulation.${langInstruction}`
      : `${dateContext}\n\nSynthesize in 2 sentences max. Lead with substance. NEVER start with "Breaking news" or "Tonight" - just state the insight directly. CRITICAL focal points with news-signal convergence are significant.${langInstruction}`;
    userPrompt = `Key takeaway:\n${headlineText}${intelSection}`;
  }

  return { systemPrompt, userPrompt };
}

// ========================================================================
// SummarizeArticle: Provider credential resolution
// ========================================================================

export interface ProviderCredentials {
  apiUrl: string;
  model: string;
  headers: Record<string, string>;
  extraBody?: Record<string, unknown>;
}

export function getProviderCredentials(provider: string): ProviderCredentials | null {
  if (provider === 'ollama') {
    const baseUrl = process.env.OLLAMA_API_URL;
    if (!baseUrl) return null;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const apiKey = process.env.OLLAMA_API_KEY;
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return {
      apiUrl: new URL('/v1/chat/completions', baseUrl).toString(),
      model: process.env.OLLAMA_MODEL || 'llama3.1:8b',
      headers,
      extraBody: { think: false },
    };
  }

  if (provider === 'groq') {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return null;
    return {
      apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.1-8b-instant',
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
      model: 'openrouter/free',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://worldmonitor.app',
        'X-Title': 'WorldMonitor',
      },
    };
  }

  return null;
}

// ========================================================================
// SummarizeHeadlines: Groq provider
// ========================================================================

export async function tryGroq(
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
// SummarizeHeadlines: OpenRouter provider
// ========================================================================

export async function tryOpenRouter(
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

