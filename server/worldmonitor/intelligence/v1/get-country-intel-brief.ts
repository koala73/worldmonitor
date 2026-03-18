import type {
  ServerContext,
  GetCountryIntelBriefRequest,
  GetCountryIntelBriefResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import { UPSTREAM_TIMEOUT_MS, TIER1_COUNTRIES, sha256Hex } from './_shared';
import { callLlm } from '../../../_shared/llm';

const INTEL_CACHE_TTL = 7200;

export async function getCountryIntelBrief(
  ctx: ServerContext,
  req: GetCountryIntelBriefRequest,
): Promise<GetCountryIntelBriefResponse> {
  const empty: GetCountryIntelBriefResponse = {
    countryCode: req.countryCode,
    countryName: '',
    brief: '',
    model: '',
    generatedAt: Date.now(),
  };

  if (!req.countryCode) return empty;

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

  const userPromptParts = [`Country: ${countryName} (${req.countryCode})`];
  if (contextSnapshot) {
    userPromptParts.push(`Context snapshot:\n${contextSnapshot}`);
  }

  let result: GetCountryIntelBriefResponse | null = null;
  try {
    result = await cachedFetchJson<GetCountryIntelBriefResponse>(cacheKey, INTEL_CACHE_TTL, async () => {
      const llmResult = await callLlm({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPromptParts.join('\n\n') },
        ],
        temperature: 0.4,
        maxTokens: 900,
        timeoutMs: UPSTREAM_TIMEOUT_MS,
      });

      if (!llmResult) return null;

      return {
        countryCode: req.countryCode,
        countryName,
        brief: llmResult.content,
        model: llmResult.model,
        generatedAt: Date.now(),
      };
    });
  } catch {
    return empty;
  }

  return result || empty;
}
