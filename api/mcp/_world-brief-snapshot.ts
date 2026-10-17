import { z } from 'zod';
import { INSIGHTS_MAX_AGE_MS } from '../../shared/insights-snapshot.js';

const publisherSchema = z.object({
  name: z.string(), tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).nullable(),
  labels: z.array(z.string()).max(4), labelsUnlisted: z.number().finite(),
}).strict();
const storySchema = z.object({
  title: z.string(), sourceCount: z.number().finite().optional(), uniqueSourceCount: z.number().finite().optional(),
  corroborationSourceCount: z.number().finite().optional(), entityCorroboration: z.boolean().optional(),
  sourceTier: z.number().finite().optional(), sources: z.array(z.string()).max(12).optional(),
  corroboration: z.object({ state: z.enum(['unknown', 'single-publisher', 'tier4-only', 'corroborated']), publishers: z.number().finite().nullable() }).strict(),
  publishers: z.array(publisherSchema).max(8), publishersUnlisted: z.number().finite(),
}).strict();
const worldBriefOriginalSchema = z.object({
  brief: z.string().min(1), summary: z.string(), headlines: z.array(z.string()).min(1).max(12),
  topStories: z.array(storySchema).min(1).max(12), provider: z.string(), model: z.string(),
  generatedAt: z.string(), stale: z.boolean(), ageMinutes: z.number().finite(),
  sources: z.array(z.object({ title: z.string(), source: z.string(), url: z.string(), publishedAt: z.string().optional() }).strict()).min(1).max(12),
}).strict();
export type WorldBriefOriginal = z.infer<typeof worldBriefOriginalSchema>;
type WorldBriefCache = { value: WorldBriefOriginal; reuseUntil: number };

export function worldBriefReuseUntil(value: unknown, now: number): number | null {
  if (!worldBriefOriginalSchema.safeParse(value).success) return null;
  const original = value as WorldBriefOriginal;
  const generatedAt = Date.parse(original.generatedAt);
  if (!Number.isFinite(generatedAt) || generatedAt > now || now >= generatedAt + INSIGHTS_MAX_AGE_MS
    || original.stale || original.summary !== original.brief
    || original.topStories.length !== original.headlines.length
    || original.topStories.some((story, i) => story.title !== original.headlines[i])
    || !original.sources.some(source => source.url !== '')) return null;
  return generatedAt + INSIGHTS_MAX_AGE_MS;
}

export function readWorldBriefCache(value: unknown, now: number, expires: number): WorldBriefOriginal | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
    || !('value' in value) || !('reuseUntil' in value)) return undefined;
  const wrapper = value as WorldBriefCache;
  const deadline = worldBriefReuseUntil(wrapper.value, now);
  if (deadline === null || !Number.isFinite(wrapper.reuseUntil) || wrapper.reuseUntil <= now
    || wrapper.reuseUntil > deadline || wrapper.reuseUntil > expires) return undefined;
  return { ...wrapper.value, ageMinutes: Math.max(0, Math.round((now - Date.parse(wrapper.value.generatedAt)) / 60000)) };
}
