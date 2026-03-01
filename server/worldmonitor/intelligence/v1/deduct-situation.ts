declare const process: { env: Record<string, string | undefined> };

import type {
    ServerContext,
    DeductSituationRequest,
    DeductSituationResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import { hashString } from './_shared';
import { CHROME_UA } from '../../../_shared/constants';

const DEDUCT_TIMEOUT_MS = 120_000;
const DEDUCT_CACHE_TTL = 3600;
const DEDUCT_API_URL = process.env.LLM_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
const DEDUCT_MODEL = process.env.LLM_MODEL || 'llama-3.1-8b-instant';

export async function deductSituation(
    _ctx: ServerContext,
    req: DeductSituationRequest,
): Promise<DeductSituationResponse> {
    const apiKey = process.env.LLM_API_KEY || process.env.GROQ_API_KEY;

    if (!apiKey) {
        return { analysis: '', model: '', provider: 'skipped' };
    }

    const MAX_QUERY_LEN = 500;
    const MAX_GEO_LEN = 2000;

    const query = typeof req.query === 'string' ? req.query.slice(0, MAX_QUERY_LEN).trim() : '';
    const geoContext = typeof req.geoContext === 'string' ? req.geoContext.slice(0, MAX_GEO_LEN).trim() : '';

    if (!query) return { analysis: '', model: '', provider: 'skipped' };

    const cacheKey = `deduct:situation:v1:${hashString(query.toLowerCase() + '|' + geoContext.toLowerCase())}`;

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

                const resp = await fetch(DEDUCT_API_URL, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                        'User-Agent': CHROME_UA
                    },
                    body: JSON.stringify({
                        model: DEDUCT_MODEL,
                        messages: [
                            { role: 'system', content: systemPrompt },
                            { role: 'user', content: userPrompt },
                        ],
                        temperature: 0.3,
                        max_tokens: 1500,
                    }),
                    signal: AbortSignal.timeout(DEDUCT_TIMEOUT_MS),
                });

                if (!resp.ok) return null;
                const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
                const firstChoice = data.choices?.[0];

                const content = firstChoice?.message?.content?.trim();
                const reasoning = (firstChoice?.message as any)?.reasoning?.trim();

                let raw = content || reasoning;
                if (!raw) return null;

                raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

                return { analysis: raw, model: DEDUCT_MODEL, provider: 'groq' };
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
