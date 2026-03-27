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
  const cacheKey = `ci-sebuf:v3:${req.countryCode}:${lang}:${contextHash}`;
  const countryName = TIER1_COUNTRIES[req.countryCode] || req.countryCode;
  const dateStr = new Date().toISOString().split('T')[0];

  const systemPrompt = `You are a senior intelligence analyst. Current date: ${dateStr}.

Generate a structured intelligence brief using EXACTLY this format:

SITUATION NOW
[2-3 sentences on what is happening and why it matters for this country]

WHAT THIS MEANS FOR ${countryName.toUpperCase()}
• [Named entity from infrastructure context]: [mechanism from active event] — [quantified impact if available]
• [Named entity]: [mechanism] — [impact]
• [Named entity]: [mechanism] — [impact]
• [Named entity]: [mechanism] — [impact]
• [Named entity]: [mechanism] — [impact]

KEY RISKS
• [Risk 1]
• [Risk 2]
• [Risk 3]

OUTLOOK
NEXT 24H: [one sentence]
NEXT 48H: [one sentence]
NEXT 72H: [one sentence]

WATCH ITEMS
[Signal 1] · [Signal 2] · [Signal 3]

Rules:
- In "WHAT THIS MEANS FOR ${countryName.toUpperCase()}": use ONLY named infrastructure entities provided in the context (ports, pipelines, cables, waterways). Include actual numbers where available.
- If no infrastructure context is provided, use named economic sectors or companies instead.
- Be specific. Avoid generic phrases like "supply chain disruption risk".
- No speculation beyond what data supports.${lang === 'fr' ? '\n- IMPORTANT: You MUST respond ENTIRELY in French language.' : ''}`;

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
        maxTokens: 1100,
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
