import { setCachedJson } from '../../../_shared/redis';
import { buildClassifyCacheKey } from './_shared';
import { CHROME_UA } from '../../../_shared/constants';
import { isProviderAvailable } from '../../../_shared/llm-health';

const VALID_LEVELS = ['critical', 'high', 'medium', 'low', 'info'];
const VALID_CATEGORIES = [
  'conflict', 'protest', 'disaster', 'diplomatic', 'economic',
  'terrorism', 'cyber', 'health', 'environmental', 'military',
  'crime', 'infrastructure', 'tech', 'general',
];

const CLASSIFY_CACHE_TTL = 86400;
const SKIP_SENTINEL_TTL = 1800;
const BATCH_SIZE = 50;

const DEFAULT_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.1-8b-instant';

function sanitizeTitle(title: string): string {
  return title.replace(/[\n\r]/g, ' ').replace(/\|/g, '/').slice(0, 200).trim();
}

function isValidUrl(url: string): boolean {
  if (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) return true;
  return url.startsWith('https://');
}

const SYSTEM_PROMPT = `You classify news headlines by threat level and category. Return ONLY a JSON array, no other text.

Levels: critical, high, medium, low, info
Categories: conflict, protest, disaster, diplomatic, economic, terrorism, cyber, health, environmental, military, crime, infrastructure, tech, general

Input: numbered lines "index|Title"
Output: [{"i":0,"l":"high","c":"conflict"}, ...]

Focus: geopolitical events, conflicts, disasters, diplomacy. Classify by real-world severity and impact.`;

export async function batchClassifyTitles(
  titles: string[],
): Promise<Map<string, { level: string; category: string }>> {
  const results = new Map<string, { level: string; category: string }>();

  const apiKey = process.env.LLM_API_KEY || process.env.GROQ_API_KEY;
  const apiUrl = process.env.LLM_API_URL || DEFAULT_API_URL;
  const model = process.env.LLM_MODEL || DEFAULT_MODEL;

  if (!apiKey) return results;

  const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT === 'production';
  if (isProd && !isValidUrl(apiUrl)) return results;

  for (let batch = 0; batch < titles.length; batch += BATCH_SIZE) {
    const chunk = titles.slice(batch, batch + BATCH_SIZE);
    const sanitized = chunk.map(t => sanitizeTitle(t));
    const prompt = sanitized.map((t, i) => `${i}|${t}`).join('\n');

    try {
      // Health gate: abort all batches if provider is unreachable
      if (!(await isProviderAvailable(apiUrl))) {
        return results;
      }

      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': CHROME_UA,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
          temperature: 0,
          max_tokens: chunk.length * 40,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!resp.ok) continue;
      const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const raw = data.choices?.[0]?.message?.content?.trim();
      if (!raw) continue;

      let parsed: Array<{ i?: number; l?: string; c?: string }>;
      try {
        const jsonMatch = raw.match(/\[[\s\S]*\]/);
        if (!jsonMatch) continue;
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        continue;
      }

      if (!Array.isArray(parsed)) continue;

      const classified = new Set<number>();
      for (const entry of parsed) {
        const idx = entry.i;
        if (typeof idx !== 'number' || idx < 0 || idx >= chunk.length) continue;
        if (classified.has(idx)) continue;
        const level = VALID_LEVELS.includes(entry.l ?? '') ? entry.l! : null;
        const category = VALID_CATEGORIES.includes(entry.c ?? '') ? entry.c! : null;
        if (!level || !category) continue;
        classified.add(idx);

        const originalTitle = chunk[idx]!;
        const cacheKey = await buildClassifyCacheKey(originalTitle);
        await setCachedJson(cacheKey, { level, category, timestamp: Date.now() }, CLASSIFY_CACHE_TTL);
        results.set(originalTitle, { level, category });
      }

      for (let i = 0; i < chunk.length; i++) {
        if (!classified.has(i)) {
          const cacheKey = await buildClassifyCacheKey(chunk[i]!);
          await setCachedJson(cacheKey, { level: '_skip', timestamp: Date.now() }, SKIP_SENTINEL_TTL);
        }
      }
    } catch {
      for (const title of chunk) {
        try {
          const cacheKey = await buildClassifyCacheKey(title);
          await setCachedJson(cacheKey, { level: '_skip', timestamp: Date.now() }, SKIP_SENTINEL_TTL);
        } catch { /* ignore sentinel write failure */ }
      }
    }
  }

  return results;
}
