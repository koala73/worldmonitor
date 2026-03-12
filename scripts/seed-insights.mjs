#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, getRedisCredentials, runSeed } from './_seed-utils.mjs';
import { clusterItems, selectTopStories } from './_clustering.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'news:insights:v1';
const DIGEST_KEY = 'news:digest:v1:full:en';
const CACHE_TTL = 1800; // 30 min — matches health maxStaleMin; survives missed cron runs
const MAX_HEADLINES = 10;
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

async function readDigestFromRedis() {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(`${url}/get/${encodeURIComponent(DIGEST_KEY)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.result ? JSON.parse(data.result) : null;
}

async function readExistingInsights() {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(`${url}/get/${encodeURIComponent(CANONICAL_KEY)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.result ? JSON.parse(data.result) : null;
}

// Provider config — mirrors server/worldmonitor/news/v1/_shared.ts getProviderCredentials()
const LLM_PROVIDERS = [
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
  {
    name: 'ollama',
    envKey: 'OLLAMA_API_URL',
    apiUrlFn: (baseUrl) => new URL('/v1/chat/completions', baseUrl).toString(),
    model: () => process.env.OLLAMA_MODEL || 'llama3.1:8b',
    headers: (_key) => {
      const h = { 'Content-Type': 'application/json', 'User-Agent': CHROME_UA };
      const apiKey = process.env.OLLAMA_API_KEY;
      if (apiKey) h['Authorization'] = `Bearer ${apiKey}`;
      return h;
    },
    extraBody: { think: false },
    timeout: 25_000,
  },
];

async function callLLM(headlines) {
  const headlineText = headlines.map((h, i) => `${i + 1}. ${h}`).join('\n');
  const dateContext = `Current date: ${new Date().toISOString().split('T')[0]}. Provide geopolitical context appropriate for the current date.`;

  const systemPrompt = `${dateContext}

Summarize the single most important headline in 2 concise sentences MAX (under 60 words total).
Rules:
- Each numbered headline below is a SEPARATE, UNRELATED story
- Pick the ONE most significant headline and summarize ONLY that story
- NEVER combine or merge people, places, or facts from different headlines into one sentence
- Lead with WHAT happened and WHERE - be specific
- NEVER start with "Breaking news", "Good evening", "Tonight", or TV-style openings
- Start directly with the subject of the chosen headline
- No bullet points, no meta-commentary, no elaboration beyond the core facts`;

  const userPrompt = `Each headline below is a separate story. Pick the most important ONE and summarize only that story:\n${headlineText}`;

  for (const provider of LLM_PROVIDERS) {
    const envVal = process.env[provider.envKey];
    if (!envVal) continue;

    const apiUrl = provider.apiUrlFn ? provider.apiUrlFn(envVal) : provider.apiUrl;
    const model = typeof provider.model === 'function' ? provider.model() : provider.model;

    try {
      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: provider.headers(envVal),
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 300,
          temperature: 0.3,
          ...provider.extraBody,
        }),
        signal: AbortSignal.timeout(provider.timeout),
      });

      if (!resp.ok) {
        console.warn(`  ${provider.name} API error: ${resp.status}`);
        continue;
      }

      const json = await resp.json();
      const rawText = json.choices?.[0]?.message?.content?.trim();
      if (!rawText) {
        console.warn(`  ${provider.name}: empty response`);
        continue;
      }

      const text = stripReasoningPreamble(rawText)
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, '')
        .replace(/<think>[\s\S]*/gi, '')
        .trim();

      if (text.length < 20) {
        console.warn(`  ${provider.name}: output too short (${text.length} chars)`);
        continue;
      }

      return { text, model: json.model || model, provider: provider.name };
    } catch (err) {
      console.warn(`  ${provider.name} failed: ${err.message}`);
      continue;
    }
  }

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

async function warmDigestCache() {
  const apiBase = process.env.API_BASE_URL || 'https://api.worldmonitor.app';
  try {
    const resp = await fetch(`${apiBase}/api/news/v1/list-feed-digest?variant=full&lang=en`, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(30_000),
    });
    if (resp.ok) console.log('  Digest cache warmed via RPC');
    else console.warn(`  Digest warm failed: HTTP ${resp.status}`);
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
  })).filter(item => item.title.length > 10);

  const clusters = clusterItems(normalizedItems);
  console.log(`  Clusters: ${clusters.length}`);

  const topStories = selectTopStories(clusters, 8);
  console.log(`  Top stories: ${topStories.length}`);

  if (topStories.length === 0) throw new Error('No top stories after scoring');

  const headlines = topStories
    .slice(0, MAX_HEADLINES)
    .map(s => sanitizeTitle(s.primaryTitle));

  let worldBrief = '';
  let briefProvider = '';
  let briefModel = '';
  let status = 'ok';

  const llmResult = await callLLM(headlines);
  if (llmResult) {
    worldBrief = llmResult.text;
    briefProvider = llmResult.provider;
    briefModel = llmResult.model;
    console.log(`  Brief generated via ${briefProvider} (${briefModel})`);
  } else {
    status = 'degraded';
    console.warn('  No LLM available — publishing degraded (stories without brief)');
  }

  const multiSourceCount = clusters.filter(c => c.sourceCount >= 2).length;
  const fastMovingCount = 0; // velocity not available in digest items

  const enrichedStories = topStories.map(story => {
    const { category, threatLevel } = categorizeStory(story.primaryTitle);
    return {
      primaryTitle: story.primaryTitle,
      primarySource: story.primarySource,
      primaryLink: story.primaryLink,
      sourceCount: story.sourceCount,
      importanceScore: story.importanceScore,
      velocity: { level: 'normal', sourcesPerHour: 0 },
      isAlert: story.isAlert,
      category,
      threatLevel,
    };
  });

  const payload = {
    worldBrief,
    briefProvider,
    briefModel,
    status,
    topStories: enrichedStories,
    generatedAt: new Date().toISOString(),
    clusterCount: clusters.length,
    multiSourceCount,
    fastMovingCount,
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

runSeed('news', 'insights', CANONICAL_KEY, fetchInsights, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'digest-clustering-v1',
}).catch((err) => {
  console.error('FATAL:', err.message || err);
  // Exit gracefully for cron — health endpoint flags stale data via seed-meta.
  process.exit(0);
});
