import type {
  ServerContext,
  ClassifyEventRequest,
  ClassifyEventResponse,
  SeverityLevel,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import { UPSTREAM_TIMEOUT_MS, buildClassifyCacheKey } from './_shared';
import { callLlm } from '../../../_shared/llm';

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
  ctx: ServerContext,
  req: ClassifyEventRequest,
): Promise<ClassifyEventResponse> {
  // Input sanitization (M-14 fix): limit title length
  const MAX_TITLE_LEN = 500;
  const title = typeof req.title === 'string' ? req.title.slice(0, MAX_TITLE_LEN) : '';
  if (!title) { markNoCacheResponse(ctx.request); return { classification: undefined }; }

  const cacheKey = await buildClassifyCacheKey(title);

  const systemPrompt = `You classify news headlines into threat level and category. Return ONLY valid JSON, no other text.

Levels: critical, high, medium, low, info
Categories: conflict, protest, disaster, diplomatic, economic, terrorism, cyber, health, environmental, military, crime, infrastructure, tech, general

Focus: geopolitical events, conflicts, disasters, diplomacy. Classify by real-world severity and impact.

Return: {"level":"...","category":"..."}`;

  let cached: { level: string; category: string; timestamp: number } | null = null;
  try {
    cached = await cachedFetchJson<{ level: string; category: string; timestamp: number }>(
      cacheKey,
      CLASSIFY_CACHE_TTL,
      async () => {
        let validatedResult: { level: string; category: string } | null = null;

        const result = await callLlm({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: title },
          ],
          temperature: 0,
          maxTokens: 50,
          timeoutMs: UPSTREAM_TIMEOUT_MS,
          validate: (content) => {
            try {
              let parsed: { level?: string; category?: string };
              try {
                parsed = JSON.parse(content);
              } catch {
                const jsonMatch = content.match(/\{[\s\S]*\}/);
                if (!jsonMatch) return false;
                parsed = JSON.parse(jsonMatch[0]);
              }
              const level = VALID_LEVELS.includes(parsed.level ?? '') ? parsed.level! : null;
              const category = VALID_CATEGORIES.includes(parsed.category ?? '') ? parsed.category! : null;
              if (!level || !category) return false;
              validatedResult = { level, category };
              return true;
            } catch {
              return false;
            }
          },
        });

        if (!result || !validatedResult) return null;
        const vr = validatedResult as { level: string; category: string };
        return { level: vr.level, category: vr.category, timestamp: Date.now() };
      },
    );
  } catch {
    markNoCacheResponse(ctx.request);
    return { classification: undefined };
  }

  if (!cached?.level || !cached?.category) { markNoCacheResponse(ctx.request); return { classification: undefined }; }

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
