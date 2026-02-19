/**
 * Intelligence service handler -- implements the generated
 * IntelligenceServiceHandler interface with 4 RPCs:
 *   - GetRiskScores       (ACLED protests -> CII + strategic risk computation)
 *   - GetPizzintStatus    (PizzINT dashboard + GDELT tension pairs)
 *   - ClassifyEvent       (Groq LLM event classification)
 *   - GetCountryIntelBrief (Groq LLM country situation brief)
 *
 * Consolidates legacy edge functions:
 *   api/risk-scores.js
 *   api/pizzint/dashboard-data.js
 *   api/pizzint/gdelt/batch.js
 *   api/classify-event.js
 *   api/country-intel.js
 */

declare const process: { env: Record<string, string | undefined> };

import type {
  IntelligenceServiceHandler,
  ServerContext,
  GetRiskScoresRequest,
  GetRiskScoresResponse,
  CiiScore,
  StrategicRisk,
  GetPizzintStatusRequest,
  GetPizzintStatusResponse,
  PizzintStatus,
  PizzintLocation,
  GdeltTensionPair,
  ClassifyEventRequest,
  ClassifyEventResponse,
  GetCountryIntelBriefRequest,
  GetCountryIntelBriefResponse,
  TrendDirection,
  DataFreshness,
  SeverityLevel,
} from '../../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

// ========================================================================
// Upstash Redis helpers (inline -- edge-compatible)
// ========================================================================

async function getCachedJson(key: string): Promise<unknown | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { result?: string };
    return data.result ? JSON.parse(data.result) : null;
  } catch {
    return null;
  }
}

async function setCachedJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  try {
    await fetch(`${url}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(JSON.stringify(value)),
      signal: AbortSignal.timeout(3_000),
    });
    await fetch(`${url}/expire/${encodeURIComponent(key)}/${ttlSeconds}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
  } catch { /* best-effort */ }
}

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    hash = ((hash << 5) - hash + c) | 0;
  }
  return Math.abs(hash).toString(36);
}

// ========================================================================
// Constants
// ========================================================================

const UPSTREAM_TIMEOUT_MS = 15_000;
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.1-8b-instant';

// ========================================================================
// GetRiskScores -- ACLED protests -> CII + strategic risk
// ========================================================================

const TIER1_COUNTRIES: Record<string, string> = {
  US: 'United States', RU: 'Russia', CN: 'China', UA: 'Ukraine', IR: 'Iran',
  IL: 'Israel', TW: 'Taiwan', KP: 'North Korea', SA: 'Saudi Arabia', TR: 'Turkey',
  PL: 'Poland', DE: 'Germany', FR: 'France', GB: 'United Kingdom', IN: 'India',
  PK: 'Pakistan', SY: 'Syria', YE: 'Yemen', MM: 'Myanmar', VE: 'Venezuela',
};

const BASELINE_RISK: Record<string, number> = {
  US: 5, RU: 35, CN: 25, UA: 50, IR: 40, IL: 45, TW: 30, KP: 45,
  SA: 20, TR: 25, PL: 10, DE: 5, FR: 10, GB: 5, IN: 20, PK: 35,
  SY: 50, YE: 50, MM: 45, VE: 40,
};

const EVENT_MULTIPLIER: Record<string, number> = {
  US: 0.3, RU: 2.0, CN: 2.5, UA: 0.8, IR: 2.0, IL: 0.7, TW: 1.5, KP: 3.0,
  SA: 2.0, TR: 1.2, PL: 0.8, DE: 0.5, FR: 0.6, GB: 0.5, IN: 0.8, PK: 1.5,
  SY: 0.7, YE: 0.7, MM: 1.8, VE: 1.8,
};

const COUNTRY_KEYWORDS: Record<string, string[]> = {
  US: ['united states', 'usa', 'america', 'washington', 'biden', 'trump', 'pentagon'],
  RU: ['russia', 'moscow', 'kremlin', 'putin'],
  CN: ['china', 'beijing', 'xi jinping', 'prc'],
  UA: ['ukraine', 'kyiv', 'zelensky', 'donbas'],
  IR: ['iran', 'tehran', 'khamenei', 'irgc'],
  IL: ['israel', 'tel aviv', 'netanyahu', 'idf', 'gaza'],
  TW: ['taiwan', 'taipei'],
  KP: ['north korea', 'pyongyang', 'kim jong'],
  SA: ['saudi arabia', 'riyadh'],
  TR: ['turkey', 'ankara', 'erdogan'],
  PL: ['poland', 'warsaw'],
  DE: ['germany', 'berlin'],
  FR: ['france', 'paris', 'macron'],
  GB: ['britain', 'uk', 'london'],
  IN: ['india', 'delhi', 'modi'],
  PK: ['pakistan', 'islamabad'],
  SY: ['syria', 'damascus'],
  YE: ['yemen', 'sanaa', 'houthi'],
  MM: ['myanmar', 'burma'],
  VE: ['venezuela', 'caracas', 'maduro'],
};

function normalizeCountryName(text: string): string | null {
  const lower = text.toLowerCase();
  for (const [code, keywords] of Object.entries(COUNTRY_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) return code;
  }
  return null;
}

function getScoreLevel(score: number): string {
  if (score >= 70) return 'critical';
  if (score >= 55) return 'high';
  if (score >= 40) return 'elevated';
  if (score >= 25) return 'normal';
  return 'low';
}

interface AcledEvent {
  country: string;
  event_type: string;
}

async function fetchACLEDProtests(): Promise<AcledEvent[]> {
  const token = process.env.ACLED_ACCESS_TOKEN;
  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const resp = await fetch(
    `https://acleddata.com/api/acled/read?_format=json&event_type=Protests&event_type=Riots&event_date=${startDate}|${endDate}&event_date_where=BETWEEN&limit=500`,
    { headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) },
  );
  if (!resp.ok) throw new Error(`ACLED API error: ${resp.status}`);
  const data = (await resp.json()) as { data?: AcledEvent[]; message?: string; error?: string };
  if (data.message || data.error) throw new Error(data.message || data.error || 'ACLED API error');
  return data.data || [];
}

function computeCIIScores(protests: AcledEvent[]): CiiScore[] {
  const countryEvents = new Map<string, { protests: number; riots: number }>();
  for (const event of protests) {
    const code = normalizeCountryName(event.country);
    if (code && TIER1_COUNTRIES[code]) {
      const count = countryEvents.get(code) || { protests: 0, riots: 0 };
      if (event.event_type === 'Riots') count.riots++;
      else count.protests++;
      countryEvents.set(code, count);
    }
  }

  const scores: CiiScore[] = [];
  for (const [code, name] of Object.entries(TIER1_COUNTRIES)) {
    const events = countryEvents.get(code) || { protests: 0, riots: 0 };
    const baseline = BASELINE_RISK[code] || 20;
    const multiplier = EVENT_MULTIPLIER[code] || 1.0;
    const unrest = Math.min(100, Math.round((events.protests + events.riots * 2) * multiplier * 2));
    const security = Math.min(100, baseline + events.riots * multiplier * 5);
    const information = Math.min(100, (events.protests + events.riots) * multiplier * 3);
    const composite = Math.min(100, Math.round(baseline + (unrest * 0.4 + security * 0.35 + information * 0.25) * 0.5));

    scores.push({
      region: code,
      staticBaseline: baseline,
      dynamicScore: composite - baseline,
      combinedScore: composite,
      trend: 'TREND_DIRECTION_STABLE' as TrendDirection,
      components: {
        newsActivity: information,
        ciiContribution: unrest,
        geoConvergence: 0,
        militaryActivity: 0,
      },
      computedAt: Date.now(),
    });
  }

  scores.sort((a, b) => b.combinedScore - a.combinedScore);
  return scores;
}

function computeStrategicRisks(ciiScores: CiiScore[]): StrategicRisk[] {
  const top5 = ciiScores.slice(0, 5);
  const weights = top5.map((_, i) => 1 - i * 0.15);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const weightedSum = top5.reduce((sum, s, i) => sum + s.combinedScore * weights[i], 0);
  const overallScore = Math.min(100, Math.round((weightedSum / totalWeight) * 0.7 + 15));

  return [
    {
      region: 'global',
      level: (overallScore >= 70
        ? 'SEVERITY_LEVEL_HIGH'
        : overallScore >= 40
          ? 'SEVERITY_LEVEL_MEDIUM'
          : 'SEVERITY_LEVEL_LOW') as SeverityLevel,
      score: overallScore,
      factors: top5.map((s) => s.region),
      trend: 'TREND_DIRECTION_STABLE' as TrendDirection,
    },
  ];
}

const RISK_CACHE_KEY = 'risk:scores:sebuf:v1';
const RISK_STALE_CACHE_KEY = 'risk:scores:sebuf:stale:v1';
const RISK_CACHE_TTL = 600;
const RISK_STALE_TTL = 3600;

async function handleGetRiskScores(_req: GetRiskScoresRequest): Promise<GetRiskScoresResponse> {
  // Check cache
  const cached = (await getCachedJson(RISK_CACHE_KEY)) as GetRiskScoresResponse | null;
  if (cached) return cached;

  try {
    const protests = process.env.ACLED_ACCESS_TOKEN ? await fetchACLEDProtests() : [];
    const ciiScores = computeCIIScores(protests);
    const strategicRisks = computeStrategicRisks(ciiScores);
    const result: GetRiskScoresResponse = { ciiScores, strategicRisks };

    await Promise.all([
      setCachedJson(RISK_CACHE_KEY, result, RISK_CACHE_TTL),
      setCachedJson(RISK_STALE_CACHE_KEY, result, RISK_STALE_TTL),
    ]);
    return result;
  } catch {
    const stale = (await getCachedJson(RISK_STALE_CACHE_KEY)) as GetRiskScoresResponse | null;
    if (stale) return stale;
    // Baseline fallback
    const ciiScores = computeCIIScores([]);
    return { ciiScores, strategicRisks: computeStrategicRisks(ciiScores) };
  }
}

// ========================================================================
// GetPizzintStatus -- PizzINT dashboard + GDELT tensions
// ========================================================================

const PIZZINT_API = 'https://www.pizzint.watch/api/dashboard-data';
const GDELT_BATCH_API = 'https://www.pizzint.watch/api/gdelt/batch';
const DEFAULT_GDELT_PAIRS = 'usa_russia,russia_ukraine,usa_china,china_taiwan,usa_iran,usa_venezuela';

async function handleGetPizzintStatus(req: GetPizzintStatusRequest): Promise<GetPizzintStatusResponse> {
  // Fetch PizzINT dashboard data
  let pizzint: PizzintStatus | undefined;
  try {
    const resp = await fetch(PIZZINT_API, {
      headers: { Accept: 'application/json', 'User-Agent': 'WorldMonitor/1.0' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (resp.ok) {
      const raw = (await resp.json()) as {
        success?: boolean;
        data?: Array<{
          place_id: string;
          name: string;
          address: string;
          current_popularity: number;
          percentage_of_usual: number | null;
          is_spike: boolean;
          spike_magnitude: number | null;
          data_source: string;
          recorded_at: string;
          data_freshness: string;
          is_closed_now?: boolean;
          lat?: number;
          lng?: number;
        }>;
      };
      if (raw.success && raw.data) {
        const locations: PizzintLocation[] = raw.data.map((d) => ({
          placeId: d.place_id,
          name: d.name,
          address: d.address,
          currentPopularity: d.current_popularity,
          percentageOfUsual: d.percentage_of_usual ?? 0,
          isSpike: d.is_spike,
          spikeMagnitude: d.spike_magnitude ?? 0,
          dataSource: d.data_source,
          recordedAt: d.recorded_at,
          dataFreshness: (d.data_freshness === 'fresh' ? 'DATA_FRESHNESS_FRESH' : 'DATA_FRESHNESS_STALE') as DataFreshness,
          isClosedNow: d.is_closed_now ?? false,
          lat: d.lat ?? 0,
          lng: d.lng ?? 0,
        }));

        const openLocations = locations.filter((l) => !l.isClosedNow);
        const activeSpikes = locations.filter((l) => l.isSpike).length;
        const avgPop = openLocations.length > 0
          ? openLocations.reduce((s, l) => s + l.currentPopularity, 0) / openLocations.length
          : 0;

        // DEFCON calculation
        let adjusted = avgPop;
        if (activeSpikes > 0) adjusted += activeSpikes * 10;
        adjusted = Math.min(100, adjusted);
        let defconLevel = 5;
        let defconLabel = 'Normal Activity';
        if (adjusted >= 85) { defconLevel = 1; defconLabel = 'Maximum Activity'; }
        else if (adjusted >= 70) { defconLevel = 2; defconLabel = 'High Activity'; }
        else if (adjusted >= 50) { defconLevel = 3; defconLabel = 'Elevated Activity'; }
        else if (adjusted >= 25) { defconLevel = 4; defconLabel = 'Above Normal'; }

        const hasFresh = locations.some((l) => l.dataFreshness === 'DATA_FRESHNESS_FRESH');

        pizzint = {
          defconLevel,
          defconLabel,
          aggregateActivity: Math.round(avgPop),
          activeSpikes,
          locationsMonitored: locations.length,
          locationsOpen: openLocations.length,
          updatedAt: Date.now(),
          dataFreshness: (hasFresh ? 'DATA_FRESHNESS_FRESH' : 'DATA_FRESHNESS_STALE') as DataFreshness,
          locations,
        };
      }
    }
  } catch { /* pizzint unavailable */ }

  // Fetch GDELT tension pairs
  let tensionPairs: GdeltTensionPair[] = [];
  if (req.includeGdelt) {
    try {
      const url = `${GDELT_BATCH_API}?pairs=${encodeURIComponent(DEFAULT_GDELT_PAIRS)}&method=gpr`;
      const resp = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'WorldMonitor/1.0' },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (resp.ok) {
        const raw = (await resp.json()) as Record<string, Array<{ t: number; v: number }>>;
        tensionPairs = Object.entries(raw).map(([pairKey, dataPoints]) => {
          const countries = pairKey.split('_');
          const latest = dataPoints[dataPoints.length - 1];
          const prev = dataPoints.length > 1 ? dataPoints[dataPoints.length - 2] : latest;
          const change = prev.v > 0 ? ((latest.v - prev.v) / prev.v) * 100 : 0;
          const trend: TrendDirection = change > 5
            ? 'TREND_DIRECTION_RISING'
            : change < -5
              ? 'TREND_DIRECTION_FALLING'
              : 'TREND_DIRECTION_STABLE';

          return {
            id: pairKey,
            countries,
            label: countries.map((c) => c.toUpperCase()).join(' - '),
            score: latest?.v ?? 0,
            trend,
            changePercent: Math.round(change * 10) / 10,
            region: 'global',
          };
        });
      }
    } catch { /* gdelt unavailable */ }
  }

  return { pizzint, tensionPairs };
}

// ========================================================================
// ClassifyEvent -- Groq LLM classification
// ========================================================================

const CLASSIFY_CACHE_TTL = 86400;
const VALID_LEVELS = ['critical', 'high', 'medium', 'low', 'info'];
const VALID_CATEGORIES = [
  'conflict', 'protest', 'disaster', 'diplomatic', 'economic',
  'terrorism', 'cyber', 'health', 'environmental', 'military',
  'crime', 'infrastructure', 'tech', 'general',
];

function mapLevelToSeverity(level: string): SeverityLevel {
  if (level === 'critical' || level === 'high') return 'SEVERITY_LEVEL_HIGH';
  if (level === 'medium') return 'SEVERITY_LEVEL_MEDIUM';
  return 'SEVERITY_LEVEL_LOW';
}

async function handleClassifyEvent(req: ClassifyEventRequest): Promise<ClassifyEventResponse> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { classification: undefined };

  const cacheKey = `classify:sebuf:v1:${hashString(req.title.toLowerCase())}`;
  const cached = (await getCachedJson(cacheKey)) as { level: string; category: string } | null;
  if (cached?.level && cached?.category) {
    return {
      classification: {
        category: cached.category,
        subcategory: '',
        severity: mapLevelToSeverity(cached.level),
        confidence: 0.9,
        analysis: '',
        entities: [],
      },
    };
  }

  try {
    const systemPrompt = `You classify news headlines into threat level and category. Return ONLY valid JSON, no other text.

Levels: critical, high, medium, low, info
Categories: conflict, protest, disaster, diplomatic, economic, terrorism, cyber, health, environmental, military, crime, infrastructure, tech, general

Focus: geopolitical events, conflicts, disasters, diplomacy. Classify by real-world severity and impact.

Return: {"level":"...","category":"..."}`;

    const resp = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: req.title },
        ],
        temperature: 0,
        max_tokens: 50,
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    if (!resp.ok) return { classification: undefined };
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) return { classification: undefined };

    let parsed: { level?: string; category?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { classification: undefined };
    }

    const level = VALID_LEVELS.includes(parsed.level ?? '') ? parsed.level! : null;
    const category = VALID_CATEGORIES.includes(parsed.category ?? '') ? parsed.category! : null;
    if (!level || !category) return { classification: undefined };

    await setCachedJson(cacheKey, { level, category, timestamp: Date.now() }, CLASSIFY_CACHE_TTL);

    return {
      classification: {
        category,
        subcategory: '',
        severity: mapLevelToSeverity(level),
        confidence: 0.9,
        analysis: '',
        entities: [],
      },
    };
  } catch {
    return { classification: undefined };
  }
}

// ========================================================================
// GetCountryIntelBrief -- Groq LLM country brief
// ========================================================================

const INTEL_CACHE_TTL = 7200;

async function handleGetCountryIntelBrief(req: GetCountryIntelBriefRequest): Promise<GetCountryIntelBriefResponse> {
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

  const systemPrompt = `You are a senior intelligence analyst providing comprehensive country situation briefs. Current date: ${dateStr}. Donald Trump is the current US President (second term, inaugurated Jan 2025).

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
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
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

// ========================================================================
// Handler export
// ========================================================================

export const intelligenceHandler: IntelligenceServiceHandler = {
  async getRiskScores(_ctx: ServerContext, req: GetRiskScoresRequest): Promise<GetRiskScoresResponse> {
    return handleGetRiskScores(req);
  },

  async getPizzintStatus(_ctx: ServerContext, req: GetPizzintStatusRequest): Promise<GetPizzintStatusResponse> {
    return handleGetPizzintStatus(req);
  },

  async classifyEvent(_ctx: ServerContext, req: ClassifyEventRequest): Promise<ClassifyEventResponse> {
    return handleClassifyEvent(req);
  },

  async getCountryIntelBrief(_ctx: ServerContext, req: GetCountryIntelBriefRequest): Promise<GetCountryIntelBriefResponse> {
    return handleGetCountryIntelBrief(req);
  },
};
