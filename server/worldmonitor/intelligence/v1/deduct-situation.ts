import type {
    ServerContext,
    DeductSituationRequest,
    DeductSituationResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';
import { sha256Hex } from './_shared';
import { callLlmReasoning } from '../../../_shared/llm';
import { aiRoutingCacheSuffix, resolveAiRouting, toLlmRoutingPolicy } from '../../../_shared/ai-routing-policy';
// Issue #3724 (extension): prediction-market titles flow into the deduction
// LLM's prompt. Use the semantic + structural sanitizer, not the lighter
// sanitizeHeadline, so that a compromised market feed cannot inject
// instruction-override phrases into the forecaster's context.
//
// The *Line* variant (#5857): each title is composed into a `- "..."` row and
// the rows are newline-joined, so the newline is this block's delimiter.
// sanitizeForPrompt preserves a lone newline by design -- correct for prose,
// wrong here, where one feed-supplied newline forges an extra market row the
// model reads as a separate, real datum.
import { sanitizeForPromptLine } from '../../../_shared/llm-sanitize.js';
import { buildDeductionPrompt, postProcessDeductionOutput } from './deduction-prompt';
import { isCallerPremium } from '../../../_shared/premium-check';
import { markUnservedLlmResponse } from '../../../_shared/response-headers';

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

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;
const DIGITS_ONLY = /^\p{N}+$/u;
// Words that appear in most market titles ("Will ... by December 31, 2026?")
// or most questions. Matching on them sent off-topic markets to the model as
// evidence.
const NON_TOPIC_WORDS = new Set([
  'a', 'an', 'and', 'or', 'but', 'not', 'no', 'yes', 'if', 'so', 'as', 'at', 'by', 'in', 'of', 'on', 'to', 'up',
  'is', 'be', 'it', 'do', 'we', 'i', 'me', 'my', 'the', 'for', 'are', 'was', 'were', 'been', 'being', 'will',
  'would', 'can', 'could', 'should', 'may', 'might', 'must', 'does', 'did', 'has', 'have', 'had', 'what', 'which',
  'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'with', 'from', 'into', 'onto', 'than', 'then', 'that',
  'this', 'these', 'those', 'there', 'their', 'they', 'them', 'its', 'his', 'her', 'our', 'your', 'you', 'about',
  'over', 'under', 'after', 'before', 'between', 'during', 'any', 'all', 'some', 'more', 'most', 'other', 'such',
  'only', 'also', 'very', 'just', 'new', 'next', 'end', 'per', 'via', 'out', 'off', 'own', 'same', 'both', 'each',
  'few', 'here', 'once', 'implications', 'impact', 'impacts', 'outlook', 'likely', 'likelihood', 'effect',
  'effects', 'consequences', 'happen', 'january', 'february', 'march', 'april', 'june', 'july', 'august',
  'september', 'october', 'november', 'december', 'year',
]);

function topicWords(text: string): string[] {
  return [...new Set(text.toLowerCase().split(WORD_SPLIT))]
    // One letter is never a topic: it is the "s" or "t" left by splitting
    // "What's" or "don't" on the apostrophe.
    .filter((w) => w.length > 1 && !NON_TOPIC_WORDS.has(w) && !DIGITS_ONLY.test(w));
}

// A shared prefix of 4+ letters pairs "iran" with "iranian" either way round;
// shorter words must match exactly so "war" never matches "warsaw".
function sameTopicWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

// Exported for tests: the guard below is only meaningful if a test can drive a
// newline-bearing title through the real builder.
export function buildPredictionContext(query: string, bootstrap: PredictionBootstrap): string {
  const allMarkets = [
    ...(bootstrap.geopolitical ?? []),
    ...(bootstrap.tech ?? []),
    ...(bootstrap.finance ?? []),
  ];
  if (!allMarkets.length) return '';

  const words = topicWords(query);

  const scored = allMarkets.map((m) => {
    const titleWords = words.length && typeof m.title === 'string' ? topicWords(m.title) : [];
    return {
      market: m,
      score: words.filter((w) => titleWords.some((t) => sameTopicWord(w, t))).length,
    };
  });

  const matched = scored
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.market.volume - a.market.volume)
    .slice(0, MAX_PREDICTION_MARKETS)
    .map(({ market }) => market);

  if (!matched.length) return '';

  const lines = matched.map((m) => {
    const title = sanitizeForPromptLine(m.title);
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

    if (!query) {
        markUnservedLlmResponse(ctx.request);
        return { analysis: '', model: '', provider: 'skipped' };
    }

    const [queryHash, frameworkHashFull, predictionBootstrap] = await Promise.all([
        // JSON keeps the field boundary: a bare '|' join hashed ("a|b", "") and
        // ("a", "b|") as the same text.
        sha256Hex(JSON.stringify([query.toLowerCase(), geoContext.toLowerCase()])),
        framework ? sha256Hex(framework) : Promise.resolve(''),
        getCachedJson(PREDICTION_BOOTSTRAP_KEY, true).catch(() => null),
    ]);
    // Full digest: the framework is caller-supplied text, and a truncated hash
    // would let a crafted framework collide with another user's cache entry.
    const frameworkHash = framework ? frameworkHashFull : '';

    const predictionContext = predictionBootstrap
        ? buildPredictionContext(query, predictionBootstrap as PredictionBootstrap)
        : '';

    // The routing policy does not read the prediction context, and both feed
    // the cache key, so resolve them together instead of back to back.
    const [predictionHash, aiRouting] = await Promise.all([
        predictionContext ? sha256Hex(predictionContext).then((hash) => hash.slice(0, 8)) : Promise.resolve(''),
        // The query and framework are the caller's own input: a restricted
        // caller's answer comes only from their allowed providers and is cached
        // apart from the shared entry.
        resolveAiRouting(ctx.request),
    ]);
    const cacheKey = `deduct:situation:v4:${queryHash.slice(0, 16)}${frameworkHash ? ':fw' + frameworkHash : ''}${predictionHash ? ':pm' + predictionHash : ''}${aiRoutingCacheSuffix(aiRouting)}`;

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
                // Since 2026-09-26 deepseek-v4-flash spends the full 1500
                // tokens on hidden reasoning and returns empty content
                // (finish_reason "length"); a budget large enough for both
                // runs ~18s, past the model's 15s attempt cap. Reasoning off
                // answers the same prompt in ~3-6s with ~700 tokens.
                enableReasoning: false,
                timeoutMs: DEDUCT_TIMEOUT_MS,
                stage: 'deduct-situation',
                systemAppend: framework || undefined,
                routingPolicy: toLlmRoutingPolicy(aiRouting),
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
        // The LLM budget expired or the provider failed: the caller receives
        // no analysis, so the daily-quota slot the gateway reserved for this
        // call is released (see markUnservedLlmResponse).
        markUnservedLlmResponse(ctx.request);
        return { analysis: '', model: '', provider: 'error' };
    }

    return {
        analysis: cached.analysis,
        model: cached.model,
        provider: cached.provider,
    };
}
