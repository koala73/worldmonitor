declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  GetCountryIntelBriefRequest,
  GetCountryIntelBriefResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getCachedJson, setCachedJson } from '../../../_shared/redis';
import { UPSTREAM_TIMEOUT_MS, GROQ_API_URL, GROQ_MODEL, TIER1_COUNTRIES } from './_shared';
import { CHROME_UA } from '../../../_shared/constants';

// ========================================================================
// Constants
// ========================================================================

const INTEL_CACHE_TTL = 7200;

// ========================================================================
// RPC handler
// ========================================================================

export async function getCountryIntelBrief(
  _ctx: ServerContext,
  req: GetCountryIntelBriefRequest,
): Promise<GetCountryIntelBriefResponse> {
  const empty: GetCountryIntelBriefResponse = {
    countryCode: req.countryCode,
    countryName: '',
    brief: '',
    model: GROQ_MODEL,
    generatedAt: Date.now(),
  };

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return empty;

  const cacheKey = `ci-sebuf:v1:${req.countryCode}`;
  const cached = (await getCachedJson(cacheKey)) as GetCountryIntelBriefResponse | null;
  if (cached?.brief) return cached;

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
- Use plain language, not jargon`;

  try {
    const resp = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Country: ${countryName} (${req.countryCode})` },
        ],
        temperature: 0.4,
        max_tokens: 900,
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    if (!resp.ok) return empty;
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const brief = data.choices?.[0]?.message?.content?.trim() || '';

    const result: GetCountryIntelBriefResponse = {
      countryCode: req.countryCode,
      countryName,
      brief,
      model: GROQ_MODEL,
      generatedAt: Date.now(),
    };

    if (brief) await setCachedJson(cacheKey, result, INTEL_CACHE_TTL);
    return result;
  } catch {
    return empty;
  }
}
