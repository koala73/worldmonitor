#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, getRedisCredentials, runSeed, withRetry, httpRetryError, createLlmBudgetError, isLlmBudgetError } from './_seed-utils.mjs';
import {
  clusterItems,
  computeEntityCorroboration,
  selectTopStories,
  DIPLOMACY_KEYWORDS,
  ENTITY_BIGRAMS,
} from './_clustering.mjs';
import { extractCountryCode } from './shared/geo-extract.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import {
  pickBriefCluster,
  briefSystemPrompt,
  briefUserPrompt,
  synthesisSystemPrompt,
  synthesisUserPrompt,
  composeSynthesizedBrief,
} from './_insights-brief.mjs';
import { buildLlmCallEvent, emitLlmEvents, flushPendingLlmEvents } from './lib/llm-telemetry.cjs';
// Import from the scripts mirror (`scripts/shared/`) — NOT the repo-root
// `shared/`. Railway services with nixpacks `rootDirectory=scripts` only
// package files under scripts/; a `../shared/` import resolves to
// `/shared/...` at runtime which is absent in the container and crashes
// the seeder on startup. The local pattern is the `./shared/geo-extract.mjs`
// line above. PR #3836 review caught this. See skill
// railway-deploy-gotchas/reference/nixpacks-root-dir-scripts-cross-dir-import-escape.
import { validateNoHallucinatedProperNouns } from './shared/brief-llm-core.js';

// Hallucination validator rollout mode (PR-2 of brief-content-quality
// regressions). `shadow` = log violations to Sentry but ship the LLM
// output unchanged (default, safe). `enforce` = on violation, replace
// the LLM summary with the source headline. Flip via Railway env after
// the 7-day shadow window confirms <5% violation rate.
// #4921: enforce is the DEFAULT — the shadow window measured its
// false-positive rate; shipping detected hallucinations was the residual
// risk. Set BRIEF_VALIDATOR_MODE=shadow to revert during an incident.
const BRIEF_VALIDATOR_MODE =
  process.env.BRIEF_VALIDATOR_MODE === 'shadow' ? 'shadow' : 'enforce';

// True only when run directly as a cron entry (node seed-insights.mjs), false
// when imported by tests — so importing the module doesn't load .env or fire a
// live seed. Mirrors seed-forecasts.mjs.
const _isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (_isDirectRun) loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'news:insights:v1';
const DIGEST_KEY = 'news:digest:v1:full:en';

// Defense-in-depth auth — see seed-infra.mjs for the same pattern + rationale.
// Set WORLDMONITOR_RELAY_KEY on the Railway service (must match a value in
// Vercel's WORLDMONITOR_VALID_KEYS). Origin alone is no longer reliable
// because CF/Vercel intermediaries may strip it and CF can cache the 401.
const RELAY_API_KEY = process.env.WORLDMONITOR_RELAY_KEY || '';

// Digest items store proto enum strings (THREAT_LEVEL_HIGH etc.) from toProtoItem().
// Normalize to client-side lowercase values before propagating into insights output.
const PROTO_TO_LEVEL = {
  THREAT_LEVEL_CRITICAL: 'critical',
  THREAT_LEVEL_HIGH: 'high',
  THREAT_LEVEL_MEDIUM: 'medium',
  THREAT_LEVEL_LOW: 'low',
  THREAT_LEVEL_UNSPECIFIED: 'info',
};

function normalizeThreat(threat) {
  if (!threat) return undefined;
  const level = PROTO_TO_LEVEL[threat.level] ?? threat.level;
  return { ...threat, level };
}

const CACHE_TTL = 10800; // 3h — 6x the 30 min cron interval. Shorter = key expires on any missed
                         // cron tick and /api/bootstrap loses insights entirely. Bad brief content
                         // is gated at brief-selection time (see pickBriefCluster + briefSystemPrompt
                         // in _insights-brief.mjs), not by aging out fast.
const MAX_HEADLINE_LEN = 500;
const GROQ_MODEL = 'llama-3.1-8b-instant';

const TASK_NARRATION = /^(we need to|i need to|let me|i'll |i should|i will |the task is|the instructions|according to the rules|so we need to|okay[,.]\s*(i'll|let me|so|we need|the task|i should|i will)|sure[,.]\s*(i'll|let me|so|we need|the task|i should|i will|here)|first[, ]+(i|we|let)|to summarize (the headlines|the task|this)|my task (is|was|:)|step \d)/i;
const PROMPT_ECHO = /^(summarize the top story|summarize the key|rules:|here are the rules|the top story is likely)/i;

function stripReasoningPreamble(text) {
  const trimmed = text.trim();
  if (TASK_NARRATION.test(trimmed) || PROMPT_ECHO.test(trimmed)) {
    const lines = trimmed.split('\n').filter(l => l.trim());
    const clean = lines.filter(l => !TASK_NARRATION.test(l.trim()) && !PROMPT_ECHO.test(l.trim()));
    return clean.join('\n').trim() || trimmed;
  }
  return trimmed;
}

function sanitizeTitle(title) {
  if (typeof title !== 'string') return '';
  return title
    .replace(/<[^>]*>/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .slice(0, MAX_HEADLINE_LEN)
    .trim();
}

function clipText(value, maxLen) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > maxLen ? `${text.slice(0, maxLen - 1).trim()}...` : text;
}

function normalizeBriefSourceUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function normalizePublishedAt(value) {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function briefSourceFromStory(story) {
  const url = normalizeBriefSourceUrl(story?.primaryLink);
  const title = clipText(story?.primaryTitle, 160);
  const source = clipText(story?.primarySource, 80);
  if (!url || !title || !source) return null;
  const publishedAt = normalizePublishedAt(story?.pubDate);
  return publishedAt ? { title, source, url, publishedAt } : { title, source, url };
}

/**
 * #4928: the legacy single-headline brief, extracted intact from the main
 * flow (L2 of the fallback chain). Corroboration-gated via
 * pickBriefCluster; enforce/shadow semantics unchanged.
 */
async function generateLegacySingleHeadlineBrief(topStories) {
  const briefCluster = pickBriefCluster(topStories);
  const topHeadline = briefCluster ? sanitizeTitle(briefCluster.primaryTitle) : '';
  const worldBriefSources = briefCluster ? [briefSourceFromStory(briefCluster)].filter(Boolean) : [];

  if (!topHeadline) {
    console.warn('  No multi-source cluster available — publishing degraded (stories without brief)');
    return { worldBrief: '', briefProvider: '', briefModel: '', worldBriefSources, status: 'degraded' };
  }

  const llmResult = await callLLM(topHeadline);
  if (!llmResult) {
    console.warn('  No LLM available — publishing degraded (stories without brief)');
    return { worldBrief: '', briefProvider: '', briefModel: '', worldBriefSources, status: 'degraded' };
  }

  // Hallucination check: did the LLM invent proper nouns not in the
  // headline? (May 19 incident: "Lebanese President Michel Aoun pledged…"
  // against a nameless headline. docs/plans/2026-05-19-001 U2.)
  const validation = validateNoHallucinatedProperNouns(llmResult.text, topHeadline);
  if (!validation.ok) {
    const hallucinated = (validation.hallucinated || []).join(' ');
    if (BRIEF_VALIDATOR_MODE === 'enforce') {
      console.warn(`  [brief_hallucination ENFORCE] dropped LLM summary: invented "${hallucinated}" not in headline; fell back to headline`);
      return {
        worldBrief: topHeadline,
        briefProvider: `${llmResult.provider}+headline-fallback`,
        briefModel: llmResult.model,
        worldBriefSources,
        status: 'ok',
      };
    }
    console.warn(`  [brief_hallucination SHADOW] would have dropped LLM summary: invented "${hallucinated}" not in headline`);
  }
  return {
    worldBrief: llmResult.text,
    briefProvider: llmResult.provider,
    briefModel: llmResult.model,
    worldBriefSources,
    status: 'ok',
  };
}

async function readDigestFromRedis() {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(`${url}/get/${encodeURIComponent(DIGEST_KEY)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.result ? unwrapEnvelope(JSON.parse(data.result)).data : null;
}

async function readExistingInsights() {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(`${url}/get/${encodeURIComponent(CANONICAL_KEY)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.result ? unwrapEnvelope(JSON.parse(data.result)).data : null;
}

// Provider config — mirrors server/_shared/llm.ts getProviderCredentials()
// Order: ollama → groq → openrouter (canonical chain)
const LLM_PROVIDERS = [
  {
    name: 'ollama',
    envKey: 'OLLAMA_API_URL',
    apiUrlFn: (baseUrl) => new URL('/v1/chat/completions', baseUrl).toString(),
    model: () => process.env.OLLAMA_MODEL || 'llama3.1:8b',
    headers: (_key) => {
      const h = { 'Content-Type': 'application/json', 'User-Agent': CHROME_UA };
      const apiKey = process.env.OLLAMA_API_KEY;
      if (apiKey) h.Authorization = `Bearer ${apiKey}`;
      return h;
    },
    extraBody: { think: false },
    timeout: 25_000,
  },
  {
    name: 'groq',
    envKey: 'GROQ_API_KEY',
    apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
    model: GROQ_MODEL,
    headers: (key) => ({ 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': CHROME_UA }),
    timeout: 15_000,
  },
  {
    name: 'openrouter',
    envKey: 'OPENROUTER_API_KEY',
    apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'google/gemini-2.5-flash',
    headers: (key) => ({ 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://worldmonitor.app', 'X-Title': 'World Monitor', 'User-Agent': CHROME_UA }),
    timeout: 20_000,
  },
];

// Bounded retry for the brief LLM call. seed-insights holds a 120s seed lock
// and makes one callLLM per run, so cap total LLM time well under it: honor a
// provider's Retry-After (429/503) instead of dropping straight to the next
// provider, but never sleep/fetch past the remaining call budget.
const INSIGHTS_LLM_MAX_RETRIES = 2;
const INSIGHTS_LLM_RETRY_BASE_MS = 1_000;
const INSIGHTS_LLM_RETRY_AFTER_MAX_MS = 10_000;
const INSIGHTS_LLM_CALL_BUDGET_MS = 60_000;
const INSIGHTS_LLM_CALL_BUDGET_GUARD_MS = 5_000;

let insightsLlmFetchForTests = null;
function __setInsightsLlmTransportForTests(overrides = null) {
  insightsLlmFetchForTests = typeof overrides?.fetch === 'function' ? overrides.fetch : null;
}

async function callLLM(headline, options = {}) {
  // #4921: callers may supply explicit prompts (the top-8 synthesis call);
  // the headline default keeps the legacy single-headline path and its
  // retry tests unchanged.
  const systemPrompt = options.systemPrompt
    ?? briefSystemPrompt(new Date().toISOString().split('T')[0]);
  const userPrompt = options.userPrompt ?? briefUserPrompt(headline);
  const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : 300;

  const insightsFetch = insightsLlmFetchForTests || ((...args) => globalThis.fetch(...args));
  const callBudgetMs = Number.isFinite(options.callBudgetMs)
    ? Math.max(0, Math.floor(options.callBudgetMs))
    : INSIGHTS_LLM_CALL_BUDGET_MS;
  const retryDelayMs = Number.isFinite(options.retryDelayMs)
    ? Math.max(0, Math.floor(options.retryDelayMs))
    : INSIGHTS_LLM_RETRY_BASE_MS;
  const budgetStartedAtMs = Date.now();
  const usableBudgetMs = () => Math.max(0, budgetStartedAtMs + callBudgetMs - Date.now() - INSIGHTS_LLM_CALL_BUDGET_GUARD_MS);

  // llm_call telemetry (#4944 U5): one event per provider OUTCOME (the
  // withRetry duration covers in-provider retries), unified with the
  // Vercel-side stream via scripts/lib/llm-telemetry.cjs.
  const promptChars = (systemPrompt?.length ?? 0) + (userPrompt?.length ?? 0);
  const events = [];
  let attemptIndex = 0;

  for (const provider of LLM_PROVIDERS) {
    const envVal = process.env[provider.envKey];
    if (!envVal) continue;

    const apiUrl = provider.apiUrlFn ? provider.apiUrlFn(envVal) : provider.apiUrl;
    const model = typeof provider.model === 'function' ? provider.model() : provider.model;
    const t0 = Date.now();
    const record = (ok, extra = {}) => {
      events.push(buildLlmCallEvent({
        provider: provider.name, model, stage: 'seed-insights', ok,
        durationMs: Date.now() - t0, promptChars, maxTokens: 300,
        fallbackIndex: attemptIndex++,
        ...extra,
      }));
    };

    try {
      const resp = await withRetry(async () => {
        const usable = usableBudgetMs();
        if (usable <= 0) throw createLlmBudgetError('insights llm budget exhausted');
        const response = await insightsFetch(apiUrl, {
          method: 'POST',
          headers: provider.headers(envVal),
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            max_tokens: maxTokens,
            temperature: 0.1,
            ...provider.extraBody,
          }),
          signal: AbortSignal.timeout(Math.max(1, Math.min(provider.timeout, usable))),
        });
        if (!response.ok) {
          throw httpRetryError(response, { maxRetryAfterMs: INSIGHTS_LLM_RETRY_AFTER_MAX_MS, capMs: usableBudgetMs() });
        }
        return response;
      }, INSIGHTS_LLM_MAX_RETRIES, retryDelayMs);

      const json = await resp.json();
      const usage = {
        tokensTotal: json.usage?.total_tokens ?? 0,
        tokensPrompt: json.usage?.prompt_tokens ?? 0,
        tokensCompletion: json.usage?.completion_tokens ?? 0,
      };
      const rawText = json.choices?.[0]?.message?.content?.trim();
      if (!rawText) {
        console.warn(`  ${provider.name}: empty response`);
        record(false, { ...usage, reason: 'empty' });
        continue;
      }

      const text = stripReasoningPreamble(rawText)
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, '')
        .replace(/<think>[\s\S]*/gi, '')
        .trim();

      if (text.length < 20) {
        console.warn(`  ${provider.name}: output too short (${text.length} chars)`);
        record(false, { ...usage, reason: 'too_short' });
        continue;
      }

      record(true, { ...usage, model: json.model || model });
      void emitLlmEvents(events); // fire-and-forget: telemetry never delays the return path
      return { text, model: json.model || model, provider: provider.name };
    } catch (err) {
      console.warn(`  ${provider.name} failed: ${err.message}`);
      const httpMatch = /HTTP (\d{3})/.exec(err.message || '');
      record(false, {
        reason: isLlmBudgetError(err) ? 'budget_exhausted'
          : err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout'
          : httpMatch ? `http_${httpMatch[1]}`
          : 'fetch_error',
      });
      // Budget spent — give up rather than burning the next provider's timeout.
      if (isLlmBudgetError(err)) {
        void emitLlmEvents(events); // fire-and-forget: telemetry never delays the return path
        return null;
      }
    }
  }

  void emitLlmEvents(events); // fire-and-forget: telemetry never delays the return path
  return null;
}

function categorizeStory(title) {
  const lower = (title || '').toLowerCase();
  const categories = [
    { keywords: ['war', 'attack', 'missile', 'troops', 'airstrike', 'combat', 'military'], cat: 'conflict', threat: 'critical' },
    { keywords: ['killed', 'dead', 'casualties', 'massacre', 'shooting'], cat: 'violence', threat: 'high' },
    { keywords: ['protest', 'uprising', 'riot', 'unrest', 'coup'], cat: 'unrest', threat: 'high' },
    { keywords: ['sanctions', 'tensions', 'escalation', 'threat'], cat: 'geopolitical', threat: 'elevated' },
    { keywords: ['crisis', 'emergency', 'disaster', 'collapse'], cat: 'crisis', threat: 'high' },
    { keywords: ['earthquake', 'flood', 'hurricane', 'wildfire', 'tsunami'], cat: 'natural_disaster', threat: 'elevated' },
    { keywords: ['election', 'vote', 'parliament', 'legislation'], cat: 'political', threat: 'moderate' },
    { keywords: ['market', 'economy', 'trade', 'tariff', 'inflation'], cat: 'economic', threat: 'moderate' },
  ];

  for (const { keywords, cat, threat } of categories) {
    if (keywords.some(kw => lower.includes(kw))) {
      return { category: cat, threatLevel: threat };
    }
  }
  return { category: 'general', threatLevel: 'moderate' };
}

function normalizedSignalText(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function clusterHasDiplomacySignal(cluster) {
  const titles = Array.isArray(cluster.memberTitles) && cluster.memberTitles.length > 0
    ? cluster.memberTitles
    : [cluster.primaryTitle];
  return titles.some((title) => {
    const text = normalizedSignalText(title);
    return DIPLOMACY_KEYWORDS.some((kw) => text.includes(kw)) ||
      ENTITY_BIGRAMS.some(([entity, action]) => text.includes(entity) && text.includes(action));
  });
}

function percentile(sortedNumbers, pct) {
  if (sortedNumbers.length === 0) return 0;
  const idx = Math.min(sortedNumbers.length - 1, Math.floor((sortedNumbers.length - 1) * pct));
  return sortedNumbers[idx];
}

function buildImportanceObservability(clusters, topStories) {
  const clusterSizes = clusters.map(c => Number(c.sourceCount) || 1).sort((a, b) => a - b);
  return {
    llmDrivenRanked: topStories.filter(s => s.threat?.source === 'llm').length,
    keywordFallbackRanked: topStories.filter(s => s.threat?.source !== 'llm' && !s.upstreamImportanceScore).length,
    diplomacyHits: clusters.filter(clusterHasDiplomacySignal).length,
    corroborationHits: clusters.filter(c => c.entityCorroboration === true).length,
    clusterSizeP50: percentile(clusterSizes, 0.5),
    clusterSizeP90: percentile(clusterSizes, 0.9),
  };
}

async function warmDigestCache() {
  const apiBase = process.env.API_BASE_URL || 'https://api.worldmonitor.app';
  const headers = {
    'User-Agent': CHROME_UA,
    Origin: 'https://worldmonitor.app',
  };
  if (RELAY_API_KEY) headers['X-WorldMonitor-Key'] = RELAY_API_KEY;
  try {
    const resp = await fetch(`${apiBase}/api/news/v1/list-feed-digest?variant=full&lang=en`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (resp.ok) console.log('  Digest cache warmed via RPC');
    else {
      const keyNote = RELAY_API_KEY ? '' : ' (WORLDMONITOR_RELAY_KEY not set — Origin-only auth)';
      console.warn(`  Digest warm failed: HTTP ${resp.status}${keyNote}`);
    }
  } catch (err) {
    console.warn(`  Digest warm failed: ${err.message}`);
  }
}

async function fetchInsights() {
  let digest = await readDigestFromRedis();
  if (!digest) {
    console.log('  Digest not in Redis, warming cache via RPC...');
    await warmDigestCache();
    // Wait for RPC write to propagate to Redis
    await new Promise(r => setTimeout(r, 3_000));
    digest = await readDigestFromRedis();
  }
  if (!digest) {
    // LKG fallback: reuse existing insights if digest is unavailable
    const existing = await readExistingInsights();
    if (existing?.topStories?.length) {
      console.log('  Digest unavailable — reusing existing insights (LKG)');
      return existing;
    }
    throw new Error('No news digest found in Redis');
  }

  // Digest shape: { categories: { politics: { items: [...] }, ... }, feedStatuses, generatedAt }
  let items;
  if (Array.isArray(digest)) {
    items = digest;
  } else if (digest.categories && typeof digest.categories === 'object') {
    items = [];
    for (const bucket of Object.values(digest.categories)) {
      if (Array.isArray(bucket.items)) items.push(...bucket.items);
    }
  } else {
    items = digest.items || digest.articles || digest.headlines || [];
  }

  if (items.length === 0) {
    const keys = typeof digest === 'object' && digest !== null ? Object.keys(digest).join(', ') : typeof digest;
    throw new Error(`Digest has no items (shape: ${keys})`);
  }

  console.log(`  Digest items: ${items.length}`);

  const normalizedItems = items.map(item => ({
    title: sanitizeTitle(item.title || item.headline || ''),
    source: item.source || item.feed || '',
    link: item.link || item.url || '',
    pubDate: item.pubDate || item.publishedAt || item.date || new Date().toISOString(),
    isAlert: item.isAlert || false,
    tier: item.tier,
    threat: normalizeThreat(item.threat),
    importanceScore: item.importanceScore,
    corroborationCount: item.corroborationCount ?? item.storyMeta?.sourceCount,
    storyMeta: item.storyMeta,
  })).filter(item => item.title.length > 10);

  const clusters = clusterItems(normalizedItems);
  console.log(`  Clusters: ${clusters.length}`);

  // #4920 coverage ledger: capture what the selection gates dropped.
  const selectionStats = {};
  const topStories = selectTopStories(clusters, 8, selectionStats);
  console.log(`  Top stories: ${topStories.length}`);
  const observability = buildImportanceObservability(clusters, topStories);
  console.log(
    `  Importance signals: llm=${observability.llmDrivenRanked} ` +
      `keywordFallback=${observability.keywordFallbackRanked} ` +
      `diplomacy=${observability.diplomacyHits} ` +
      `entityCorroboration=${observability.corroborationHits} ` +
      `clusterSizeP50=${observability.clusterSizeP50} ` +
      `clusterSizeP90=${observability.clusterSizeP90}`,
  );

  if (topStories.length === 0) throw new Error('No top stories after scoring');

  // Corroboration gate: only brief a story at least two outlets have reported.
  // See pickBriefCluster() in _insights-brief.mjs for rationale + unit tests.
  // Note: this gates ONLY brief generation — the topStories payload itself
  // continues to include single-source clusters, rendered as the headline list
  // under the brief. The brief paragraph is the one surface where corroboration
  // matters; the list is already visually marked with per-story sourceCount.
  // #4921/#4928: L1 = top-8 synthesis via the pure composer (parse +
  // corroboration gate + lead noun/anchor gates + per-line enforcement +
  // citation verification + index-locked sources — all unit-tested in
  // _insights-brief.mjs). L2 = legacy single-headline brief. Degraded last.
  // The brief always ships.
  let worldBrief = '';
  let briefProvider = '';
  let briefModel = '';
  let briefStoryLines = [];
  let worldBriefSources = [];
  let status = 'ok';

  const synthesisResult = topStories.length > 0
    ? await callLLM(null, {
        systemPrompt: synthesisSystemPrompt(new Date().toISOString().split('T')[0]),
        userPrompt: synthesisUserPrompt(topStories),
        maxTokens: 900,
      })
    : null;
  const composed = synthesisResult
    ? composeSynthesizedBrief(synthesisResult.text, topStories, {
        validatorMode: BRIEF_VALIDATOR_MODE,
        sanitizeTitle,
        sourceFromStory: briefSourceFromStory,
      })
    : null;

  if (composed) {
    worldBrief = composed.lead;
    briefStoryLines = composed.lines;
    worldBriefSources = composed.sources;
    briefProvider = synthesisResult.provider;
    briefModel = synthesisResult.model;
    if (composed.strippedCitations > 0) {
      console.warn(`  [brief_citation ENFORCE] stripped ${composed.strippedCitations} out-of-range citation(s)`);
    }
    if (composed.hallucinatedLines > 0) {
      console.warn(`  [brief_hallucination ${BRIEF_VALIDATOR_MODE.toUpperCase()}] ${composed.hallucinatedLines}/${topStories.length} synthesis lines flagged`);
    }
    console.log(`  Brief synthesized (top-${topStories.length}) via ${briefProvider} (${briefModel})`);
  } else {
    if (synthesisResult) {
      console.warn('  [brief_synthesis] composer rejected output (parse/gates) — falling back to single-headline brief');
    }
    const legacy = await generateLegacySingleHeadlineBrief(topStories);
    worldBrief = legacy.worldBrief;
    briefProvider = legacy.briefProvider;
    briefModel = legacy.briefModel;
    worldBriefSources = legacy.worldBriefSources;
    status = legacy.status;
  }

  const multiSourceCount = clusters.filter(c => (c.sources?.length ?? 0) >= 2 || c.entityCorroboration === true).length;
  const fastMovingCount = 0; // velocity not available in digest items

  const enrichedStories = topStories.map(story => {
    // Use digest threat when present and not keyword-sourced (keyword threat uses old taxonomy).
    // Fall back to categorizeStory() for legacy/incomplete payloads.
    const hasDigestThreat = story.threat?.level && story.threat?.source !== 'keyword';
    const { category, threatLevel } = hasDigestThreat
      ? { category: story.threat.category ?? 'general', threatLevel: story.threat.level }
      : categorizeStory(story.primaryTitle);
    const countryCode = extractCountryCode(story.primaryTitle) ?? null;
    return {
      primaryTitle: story.primaryTitle,
      primarySource: story.primarySource,
      primaryLink: story.primaryLink,
      pubDate: story.pubDate,
      sourceCount: story.sourceCount,
      uniqueSourceCount: Array.isArray(story.sources) ? story.sources.length : 0,
      sources: Array.isArray(story.sources) ? story.sources : [],
      lastUpdated: story.lastUpdated,
      memberTitles: Array.isArray(story.memberTitles) ? story.memberTitles : [story.primaryTitle],
      sourceTier: story.sourceTier,
      upstreamImportanceScore: story.upstreamImportanceScore,
      entityCorroboration: story.entityCorroboration === true,
      corroborationSourceCount: story.corroborationSourceCount ?? 0,
      importanceScore: story.importanceScore,
      effectiveImportanceScore: story.effectiveImportanceScore,
      velocity: { level: 'normal', sourcesPerHour: 0 },
      isAlert: story.isAlert,
      category,
      threatLevel,
      countryCode,
    };
  });

  // #4920: user-facing provenance — "compiled from N stories across M
  // sources" — plus the selection-gate drop counts. Read by
  // insights-loader/InsightsPanel; no proto involved (plain Redis JSON).
  const provenance = {
    storiesConsidered: normalizedItems.length,
    sourcesConsidered: new Set(normalizedItems.map(item => item.source).filter(Boolean)).size,
    selectionDrops: {
      admissibility: selectionStats.admissibilityDropped ?? 0,
      sourceCap: selectionStats.sourceCapDropped ?? 0,
      overflow: selectionStats.overflowDropped ?? 0,
    },
  };
  console.log(
    `  Provenance: ${provenance.storiesConsidered} stories / ${provenance.sourcesConsidered} sources; ` +
      `drops adm=${provenance.selectionDrops.admissibility} srcCap=${provenance.selectionDrops.sourceCap} overflow=${provenance.selectionDrops.overflow}`,
  );

  // #4921 staleness footer: the age window of the BRIEF'S OWN material —
  // the top stories the synthesis cites — not the whole digest pool
  // (#4928 external review: an unrelated fresh item made the footer claim
  // the brief's sources were fresher than they are).
  const pubTimes = topStories
    .map(story => new Date(story.pubDate).getTime())
    .filter(Number.isFinite);
  const sourceAgeRange = pubTimes.length > 0
    ? { newestMs: Math.max(...pubTimes), oldestMs: Math.min(...pubTimes) }
    : null;

  const payload = {
    worldBrief,
    briefStoryLines,
    sourceAgeRange,
    worldBriefSources,
    briefProvider,
    briefModel,
    status,
    topStories: enrichedStories,
    generatedAt: new Date().toISOString(),
    clusterCount: clusters.length,
    multiSourceCount,
    fastMovingCount,
    importanceSignals: observability,
    provenance,
  };

  // LKG preservation: don't overwrite "ok" with "degraded"
  if (status === 'degraded') {
    const existing = await readExistingInsights();
    if (existing?.status === 'ok') {
      console.log('  LKG preservation: existing payload is "ok", skipping degraded overwrite');
      return existing;
    }
  }

  return payload;
}

function validate(data) {
  return Array.isArray(data?.topStories) && data.topStories.length >= 1;
}

export function declareRecords(data) {
  return Array.isArray(data?.topStories) ? data.topStories.length : 0;
}

export { callLLM, __setInsightsLlmTransportForTests };

if (_isDirectRun) {
  runSeed('news', 'insights', CANONICAL_KEY, fetchInsights, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'digest-clustering-v2-importance-diversity',

    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 30,
  }).catch(async (err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
    // Exit gracefully for cron — health endpoint flags stale data via
    // seed-meta. process.exit does not drain in-flight promises — flush
    // llm_call telemetry first (bounded by the 1.5s fetch timeout).
    await flushPendingLlmEvents();
    process.exit(0);
  });
}
