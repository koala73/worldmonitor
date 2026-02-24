declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  ClassifyEventRequest,
  ClassifyEventResponse,
  SeverityLevel,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getCachedJson, setCachedJson } from '../../../_shared/redis';
import { UPSTREAM_TIMEOUT_MS, GROQ_API_URL, GROQ_MODEL, hashString } from './_shared';
import { CHROME_UA } from '../../../_shared/constants';

// ========================================================================
// Constants
// ========================================================================

const CLASSIFY_CACHE_TTL = 86400;
const VALID_LEVELS = ['critical', 'high', 'medium', 'low', 'info'];
const VALID_CATEGORIES = [
  'conflict', 'protest', 'disaster', 'diplomatic', 'economic',
  'terrorism', 'cyber', 'health', 'environmental', 'military',
  'crime', 'infrastructure', 'tech', 'general',
];

// ========================================================================
// Helpers
// ========================================================================

function mapLevelToSeverity(level: string): SeverityLevel {
  if (level === 'critical' || level === 'high') return 'SEVERITY_LEVEL_HIGH';
  if (level === 'medium') return 'SEVERITY_LEVEL_MEDIUM';
  return 'SEVERITY_LEVEL_LOW';
}

// ========================================================================
// RPC handler
// ========================================================================

export async function classifyEvent(
  _ctx: ServerContext,
  req: ClassifyEventRequest,
): Promise<ClassifyEventResponse> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { classification: undefined };

  // Input sanitization (M-14 fix): limit title length
  const MAX_TITLE_LEN = 500;
  const title = typeof req.title === 'string' ? req.title.slice(0, MAX_TITLE_LEN) : '';
  if (!title) return { classification: undefined };

  const cacheKey = `classify:sebuf:v1:${hashString(title.toLowerCase())}`;
  const cached = (await getCachedJson(cacheKey)) as { level: string; category: string } | null;
  if (cached?.level && cached?.category) {
    return {
      classification: {
        category: cached.category,
        subcategory: cached.level,
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
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: title },
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
        subcategory: level,
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
