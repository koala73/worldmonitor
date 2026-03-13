import type {
  ServerContext,
  GetCountryIntelBriefRequest,
  GetCountryIntelBriefResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import { UPSTREAM_TIMEOUT_MS, GROQ_API_URL, GROQ_MODEL, TIER1_COUNTRIES, sha256Hex } from './_shared';
import { CHROME_UA } from '../../../_shared/constants';
import { isProviderAvailable } from '../../../_shared/llm-health';

// ========================================================================
// Constants
// ========================================================================

const INTEL_CACHE_TTL = 7200;

// ========================================================================
// RPC handler
// ========================================================================

export async function getCountryIntelBrief(
  ctx: ServerContext,
  req: GetCountryIntelBriefRequest,
): Promise<GetCountryIntelBriefResponse> {
  const apiKey = process.env.LLM_API_KEY || process.env.GROQ_API_KEY;
  const apiUrl = process.env.LLM_API_URL || GROQ_API_URL;
  const model = process.env.LLM_MODEL || GROQ_MODEL;

  const empty: GetCountryIntelBriefResponse = {
    countryCode: req.countryCode,
    countryName: '',
    brief: '',
    model,
    generatedAt: Date.now(),
  };

  if (!req.countryCode) return empty;
  if (!apiKey) return empty;

  let contextSnapshot = '';
  let lang = 'en';
  try {
    const url = new URL(ctx.request.url);
    contextSnapshot = (url.searchParams.get('context') || '').trim().slice(0, 4000);
    lang = url.searchParams.get('lang') || 'en';
  } catch {
    contextSnapshot = '';
  }

  const contextHash = contextSnapshot ? (await sha256Hex(contextSnapshot)).slice(0, 16) : 'base';
  const cacheKey = `ci-sebuf:v2:${req.countryCode}:${lang}:${contextHash}`;
  const countryName = TIER1_COUNTRIES[req.countryCode] || req.countryCode;
  const dateStr = new Date().toISOString().split('T')[0];

  const systemPrompt = `You are a senior intelligence analyst providing comprehensive country situation briefs. Current date: ${dateStr}. Provide geopolitical context appropriate for the current date.

Write a concise intelligence brief for the requested country covering:
1. Current Situation - what is happening right now
2. Military & Security Posture
3. Key Risk Factors
4. Regional Context
5. Outlook & Watch Items

Rules:
- Be specific and analytical
- 4-5 paragraphs, 250-350 words
- No speculation beyond what data supports
- Use plain language, not jargon
- If a context snapshot is provided, explicitly reflect each non-zero signal category in the brief${lang === 'fr' ? '\n- IMPORTANT: You MUST respond ENTIRELY in French language.' : ''}`;

  let result: GetCountryIntelBriefResponse | null = null;
  try {
    result = await cachedFetchJson<GetCountryIntelBriefResponse>(cacheKey, INTEL_CACHE_TTL, async () => {
      // Health gate inside fetcher — only runs on cache miss
      if (!(await isProviderAvailable(apiUrl))) return null;
      try {
        const userPromptParts = [
          `Country: ${countryName} (${req.countryCode})`,
        ];
        if (contextSnapshot) {
          userPromptParts.push(`Context snapshot:\n${contextSnapshot}`);
        }

        const resp = await fetch(apiUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPromptParts.join('\n\n') },
            ],
            temperature: 0.4,
            max_tokens: 900,
          }),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });

        if (!resp.ok) return null;
        const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const brief = data.choices?.[0]?.message?.content?.trim() || '';
        if (!brief) return null;

        return {
          countryCode: req.countryCode,
          countryName,
          brief,
          model,
          generatedAt: Date.now(),
        };
      } catch {
        return null;
      }
    });
  } catch {
    return empty;
  }

  return result || empty;
}
