declare const process: { env: Record<string, string | undefined> };

import type {
    ServerContext,
    DeductSituationRequest,
    DeductSituationResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import { UPSTREAM_TIMEOUT_MS, GROQ_API_URL, GROQ_MODEL, hashString } from './_shared';
import { CHROME_UA } from '../../../_shared/constants';

const DEDUCT_CACHE_TTL = 3600; // 1 hour caching for deductions

export async function deductSituation(
    _ctx: ServerContext,
    req: DeductSituationRequest,
): Promise<DeductSituationResponse> {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return { analysis: '', model: '', provider: 'skipped' };

    const MAX_QUERY_LEN = 500;
    const MAX_GEO_LEN = 2000;

    const query = typeof req.query === 'string' ? req.query.slice(0, MAX_QUERY_LEN).trim() : '';
    const geoContext = typeof req.geoContext === 'string' ? req.geoContext.slice(0, MAX_GEO_LEN).trim() : '';

    if (!query) return { analysis: '', model: '', provider: 'skipped' };

    const cacheKey = `deduct:sebuf:v1:${hashString(query.toLowerCase() + '|' + geoContext.toLowerCase())}`;

    const cached = await cachedFetchJson<{ analysis: string; model: string; provider: string }>(
        cacheKey,
        DEDUCT_CACHE_TTL,
        async () => {
            try {
                const systemPrompt = `You are a senior geopolitical intelligence analyst and forecaster.
Your task is to DEDUCT the situation in a near timeline (e.g. 24 hours to a few months) based on the user's query.
- Use any provided geographic or intelligence context.
- Be highly analytical, pragmatic, and objective.
- Identify the most likely outcomes, timelines, and second-order impacts.
- Do NOT use typical AI preambles (e.g., "Here is the deduction", "Let me see").
- Format your response in clean markdown with concise bullet points where appropriate.`;

                let userPrompt = query;
                if (geoContext) {
                    userPrompt += `\n\n### Current Intelligence Context\n${geoContext}`;
                }

                const resp = await fetch(GROQ_API_URL, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                        'User-Agent': CHROME_UA
                    },
                    body: JSON.stringify({
                        model: GROQ_MODEL,
                        messages: [
                            { role: 'system', content: systemPrompt },
                            { role: 'user', content: userPrompt },
                        ],
                        temperature: 0.3,
                        max_tokens: 500,
                    }),
                    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
                });

                if (!resp.ok) return null;
                const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
                let raw = data.choices?.[0]?.message?.content?.trim();
                if (!raw) return null;

                // Strip thinking blocks if the model returns them
                raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

                return { analysis: raw, model: GROQ_MODEL, provider: 'groq' };
            } catch (err) {
                console.error('[DeductSituation] Error calling LLM:', err);
                return null;
            }
        }
    );

    if (!cached?.analysis) {
        return { analysis: '', model: '', provider: 'error' };
    }

    return {
        analysis: cached.analysis,
        model: cached.model,
        provider: cached.provider,
    };
}
