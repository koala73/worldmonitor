import type {
    ServerContext,
    DeductSituationRequest,
    DeductSituationResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import { sha256Hex } from './_shared';
import { callLlm } from '../../../_shared/llm';
import { buildDeductionPrompt, postProcessDeductionOutput } from './deduction-prompt';

const DEDUCT_TIMEOUT_MS = 120_000;
const DEDUCT_CACHE_TTL = 3600;

export async function deductSituation(
    _ctx: ServerContext,
    req: DeductSituationRequest,
): Promise<DeductSituationResponse> {
    const MAX_QUERY_LEN = 500;
    const MAX_GEO_LEN = 2000;
    const MAX_FRAMEWORK_LEN = 2000;

    const query = typeof req.query === 'string' ? req.query.slice(0, MAX_QUERY_LEN).trim() : '';
    const geoContext = typeof req.geoContext === 'string' ? req.geoContext.slice(0, MAX_GEO_LEN).trim() : '';
    const framework = typeof req.framework === 'string' ? req.framework.slice(0, MAX_FRAMEWORK_LEN) : '';

    if (!query) return { analysis: '', model: '', provider: 'skipped' };

    const cacheKey = `deduct:situation:v2:${(await sha256Hex(query.toLowerCase() + '|' + geoContext.toLowerCase())).slice(0, 16)}`;

    const { mode, systemPrompt, userPrompt } = buildDeductionPrompt({ query, geoContext });

    const cached = await cachedFetchJson<{ analysis: string; model: string; provider: string }>(
        cacheKey,
        DEDUCT_CACHE_TTL,
        async () => {
            const result = await callLlm({
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                temperature: 0.3,
                maxTokens: 1500,
                timeoutMs: DEDUCT_TIMEOUT_MS,
                systemAppend: framework || undefined,
            });

            if (!result) return null;
            const analysis = postProcessDeductionOutput(result.content, mode);
            return { analysis, model: result.model, provider: result.provider };
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
