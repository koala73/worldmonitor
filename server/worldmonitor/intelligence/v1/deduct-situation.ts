import type {
    ServerContext,
    DeductSituationRequest,
    DeductSituationResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';
import { sha256Hex } from './_shared';
import { callLlmReasoning } from '../../../_shared/llm';
// Issue #3724 (extension): prediction-market titles flow into the deduction
// LLM's prompt. Use sanitizeForPrompt (semantic + structural), not the lighter
// sanitizeHeadline, so that a compromised market feed cannot inject
// instruction-override phrases into the forecaster's context.
import { sanitizeForPrompt } from '../../../_shared/llm-sanitize.js';
import { buildDeductionPrompt, postProcessDeductionOutput } from './deduction-prompt';
import { isCallerPremium } from '../../../_shared/premium-check';

const PREDICTION_BOOTSTRAP_KEY = 'prediction:markets-bootstrap:v1';
const MAX_PREDICTION_MARKETS = 7;

interface PredictionMarketRaw {
  title: string;
  yesPrice: number;
  volume: number;
  source?: string;
}

interface PredictionBootstrap {
  geopolitical?: PredictionMarketRaw[];
  tech?: PredictionMarketRaw[];
  finance?: PredictionMarketRaw[];
}

function formatVolume(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}K`;
  return `$${v}`;
}

function buildPredictionContext(query: string, bootstrap: PredictionBootstrap): string {
  const allMarkets = [
    ...(bootstrap.geopolitical ?? []),
    ...(bootstrap.tech ?? []),
    ...(bootstrap.finance ?? []),
  ];
  if (!allMarkets.length) return '';

  const words = query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 1);

  const scored = allMarkets.map((m) => ({
    market: m,
    score: words.length
      ? words.filter((w) => typeof m.title === 'string' && m.title.toLowerCase().includes(w)).length
      : 0,
  }));

  const matched = scored
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.market.volume - a.market.volume)
    .slice(0, MAX_PREDICTION_MARKETS)
    .map(({ market }) => market);

  if (!matched.length) return '';

  const lines = matched.map((m) => {
    const title = sanitizeForPrompt(m.title);
    if (!title) return null;
    const pct = Math.round(m.yesPrice / 5) * 5;
    const vol = formatVolume(m.volume);
    return `- "${title}" — Yes ${pct}% (${vol} volume)`;
  }).filter((l): l is string => l !== null);

  if (!lines.length) return '';
  return `## Prediction Market Odds (crowd-calibrated)\n${lines.join('\n')}`;
}

// This route runs on the Vercel Edge gateway (api/intelligence/v1/[rpc].ts →
// runtime: 'edge'), which enforces a 25s initial-response ceiling — same
// constraint list-feed-digest budgets under. The LLM reasoning budget must
// fail closed to the graceful `provider: 'error'` degradation below BEFORE
// the platform kills the invocation: the previous 120s budget was
// unreachable (7d of Axiom route telemetry shows no success past 23.6s),
// so every slower run surfaced as a client 504 with the LLM spend wasted
// and nothing cached (WORLDMONITOR-VP, #5147). 22s keeps the budget above
// the observed reasoning p95 (~17.5s) while leaving a 3s guard band for
// pre-LLM context assembly and response serialization.
const VERCEL_INITIAL_RESPONSE_LIMIT_MS = 25_000;
const RESPONSE_GUARD_BAND_MS = 3_000;
const DEDUCT_TIMEOUT_MS = VERCEL_INITIAL_RESPONSE_LIMIT_MS - RESPONSE_GUARD_BAND_MS;
const DEDUCT_CACHE_TTL = 3600;

export async function deductSituation(
    ctx: ServerContext,
    req: DeductSituationRequest,
): Promise<DeductSituationResponse> {
    const MAX_QUERY_LEN = 500;
    const MAX_GEO_LEN = 2000;
    const MAX_FRAMEWORK_LEN = 2000;

    const query = typeof req.query === 'string' ? req.query.slice(0, MAX_QUERY_LEN).trim() : '';
    const geoContext = typeof req.geoContext === 'string' ? req.geoContext.slice(0, MAX_GEO_LEN).trim() : '';
    const isPremium = await isCallerPremium(ctx.request);
    const framework = isPremium && typeof req.framework === 'string' ? req.framework.slice(0, MAX_FRAMEWORK_LEN) : '';

    if (!query) return { analysis: '', model: '', provider: 'skipped' };

    const [queryHash, frameworkHashFull, predictionBootstrap] = await Promise.all([
        sha256Hex(query.toLowerCase() + '|' + geoContext.toLowerCase()),
        framework ? sha256Hex(framework) : Promise.resolve(''),
        getCachedJson(PREDICTION_BOOTSTRAP_KEY, true).catch(() => null),
    ]);
    const frameworkHash = framework ? frameworkHashFull.slice(0, 8) : '';

    const predictionContext = predictionBootstrap
        ? buildPredictionContext(query, predictionBootstrap as PredictionBootstrap)
        : '';

    const predictionHash = predictionContext ? (await sha256Hex(predictionContext)).slice(0, 8) : '';
    const cacheKey = `deduct:situation:v2:${queryHash.slice(0, 16)}${frameworkHash ? ':fw' + frameworkHash : ''}${predictionHash ? ':pm' + predictionHash : ''}`;

    const { mode, systemPrompt, userPrompt } = buildDeductionPrompt({ query, geoContext, predictionContext });

    const cached = await cachedFetchJson<{ analysis: string; model: string; provider: string }>(
        cacheKey,
        DEDUCT_CACHE_TTL,
        async () => {
            const result = await callLlmReasoning({
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                temperature: 0.3,
                maxTokens: 1500,
                timeoutMs: DEDUCT_TIMEOUT_MS,
                stage: 'deduct-situation',
                systemAppend: framework || undefined,
            });

            if (!result) return null;
            const analysis = postProcessDeductionOutput(result.content, mode);
            return { analysis, model: result.model, provider: result.provider };
        },
        undefined,
        // Cache safety net must sit above the LLM's own timeout so the
        // caller's bound wins; otherwise the inflight wrapper rejects at
        // the 30s default before callLlmReasoning can complete (#3539).
        { timeoutMs: DEDUCT_TIMEOUT_MS + 5_000 },
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
