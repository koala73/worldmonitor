import type {
  ServerContext,
  GetCountryIntelBriefRequest,
  GetCountryIntelBriefResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';
import { UPSTREAM_TIMEOUT_MS, TIER1_COUNTRIES, sha256Hex } from './_shared';
import { callLlm } from '../../../_shared/llm';
import { isCallerPremium } from '../../../_shared/premium-check';
import { sanitizeForPrompt } from '../../../_shared/llm-sanitize.js';
import { ENERGY_SPINE_KEY_PREFIX } from '../../../_shared/cache-keys';

const INTEL_CACHE_TTL = 21600;

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
    contextSnapshot = sanitizeForPrompt((url.searchParams.get('context') || '').trim().slice(0, 4000));
    lang = url.searchParams.get('lang') || 'en';
  } catch {
    contextSnapshot = '';
  }

  const isPremium = await isCallerPremium(ctx.request);
  const frameworkRaw = isPremium && typeof req.framework === 'string' ? req.framework.slice(0, 2000) : '';

  // Fetch energy mix early so its data-year can be included in the cache key.
  // This ensures cached briefs are invalidated when OWID publishes updated annual
  // data — without it, energy mix changes are silently ignored in cached briefs.
  // Prefer reading from spine (single key); fall back to direct mix key on miss.
  let energyMixData: Record<string, unknown> | null = null;
  try {
    const spine = await getCachedJson(`${ENERGY_SPINE_KEY_PREFIX}${req.countryCode.toUpperCase()}`, true) as Record<string, unknown> | null;
    if (spine != null && typeof spine === 'object' && spine.mix != null) {
      const src = spine.sources as Record<string, unknown> | undefined;
      energyMixData = {
        ...(spine.mix as Record<string, unknown>),
        year: src?.mixYear ?? null,
      };
    } else {
      const raw = await getCachedJson(`energy:mix:v1:${req.countryCode.toUpperCase()}`, true);
      if (raw && typeof raw === 'object') energyMixData = raw as Record<string, unknown>;
    }
  } catch { /* graceful omit */ }
  const energyYear = typeof energyMixData?.year === 'number' ? String(energyMixData.year) : '';

  const [contextHashFull, frameworkHashFull] = await Promise.all([
    contextSnapshot ? sha256Hex(contextSnapshot) : Promise.resolve('base'),
    frameworkRaw    ? sha256Hex(frameworkRaw)    : Promise.resolve(''),
  ]);
  const contextHash = contextSnapshot ? contextHashFull.slice(0, 16) : 'base';
  const frameworkHash = frameworkRaw ? frameworkHashFull.slice(0, 8) : '';
  const energyTag = energyYear ? `:e${energyYear}` : '';
  const cacheKey = `ci-sebuf:v3:${req.countryCode}:${lang}:${contextHash}${frameworkHash ? `:${frameworkHash}` : ''}${energyTag}`;
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

  if (energyMixData) {
    const yr = energyYear || '';
    userPromptParts.push(
      `Energy generation mix (${yr}): coal ${energyMixData.coalShare ?? '?'}%, ` +
      `gas ${energyMixData.gasShare ?? '?'}%, renewables ${energyMixData.renewShare ?? '?'}%, ` +
      `nuclear ${energyMixData.nuclearShare ?? '?'}%, net import dependency ${energyMixData.importShare ?? '?'}%.`,
    );
  }

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
        systemAppend: frameworkRaw || undefined,
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
