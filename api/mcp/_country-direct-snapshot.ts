import { z } from 'zod';

const clockSchema = z.union([z.number().finite().nonnegative(), z.string().min(1)]);
const provenanceSchema = z.object({
    risk: z.string(), type: z.string(), riskDeclared: z.boolean(), typeDeclared: z.boolean(),
    riskReviewed: z.boolean(), typeReviewed: z.boolean(), knownBiases: z.array(z.string()),
    stateAffiliated: z.string().optional(), note: z.string().optional(),
}).passthrough();
const sourceSchema = z.object({
  title: z.string(), source: z.string(), url: z.string(), publishedAt: z.string().optional(),
  sourceProvenance: provenanceSchema.optional(),
}).passthrough();
const evidenceSchema = z.object({
  id: z.string(), kind: z.string(), label: z.string(), value: z.string(),
  factText: z.string(), asOf: z.string(), url: z.string(),
}).passthrough();
const groundingSchema = z.object({
  title: z.string(), source: z.string(), url: z.string().optional(), publishedAt: z.string().optional(),
  corroborationCount: z.number().finite(), mentionCount: z.number().finite().optional(), storyPhase: z.string().optional(),
  corroboration: z.object({ state: z.enum(['unknown', 'single-publisher', 'tier4-only', 'corroborated']), publishers: z.number().finite().nullable() }).passthrough(),
  sourceProvenance: provenanceSchema.optional(),
  publishers: z.array(z.object({
    name: z.string(), tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).nullable(), labels: z.array(z.string()), labelsUnlisted: z.number().finite(),
  }).passthrough()).optional(), publishersUnlisted: z.number().finite().optional(),
}).passthrough();
const briefSchema = z.object({
  countryCode: z.string(), countryName: z.string(), brief: z.string().trim().min(1), model: z.string(), generatedAt: clockSchema,
  sources: z.array(sourceSchema), evidence: z.array(evidenceSchema).optional(), groundingStories: z.array(groundingSchema),
  digestCoverage: z.object({ state: z.literal('complete'), servedStale: z.literal(false), staleReason: z.string().optional(), staleAgeSeconds: z.number().finite().optional(), attemptedAt: z.string().optional() }).passthrough(),
}).passthrough();
const ciiSchema = z.object({
  region: z.string(), combinedScore: z.number().finite(), staticBaseline: z.number().finite(), dynamicScore: z.number().finite(), trend: z.string(),
  components: z.object({ ciiContribution: z.number().finite(), geoConvergence: z.number().finite(), militaryActivity: z.number().finite(), newsActivity: z.number().finite() }).passthrough(),
  computedAt: z.number().finite().nonnegative(), methodologyVersion: z.string().optional(), eventMultiplier: z.number().finite().optional(), advisoryLevel: z.string().optional(), advisoryProvenance: z.string().optional(),
}).passthrough();
const riskSchema = z.object({
  countryCode: z.string(), countryName: z.string(), advisoryLevel: z.string(), sanctionsActive: z.boolean(), sanctionsCount: z.number().finite(),
  fetchedAt: z.number().finite().nonnegative(), upstreamUnavailable: z.literal(false), cii: ciiSchema.nullable().optional(),
}).passthrough();

export function isCountryDirectOriginalReusable(name: 'get_country_brief' | 'get_country_risk', value: unknown, country: string, now: number): boolean {
  if (value && typeof value === 'object' && ('panelRequest' in value || 'usage' in value)) return false;
  if (name === 'get_country_brief') {
    const parsed = briefSchema.safeParse(value);
    if (!parsed.success) return false;
    const original = parsed.data;
    const generated = typeof original.generatedAt === 'number' ? original.generatedAt : Date.parse(original.generatedAt);
    return original.countryCode === country && Number.isFinite(generated) && generated >= 0 && generated <= now
      && !original.digestCoverage.staleReason
      && !['stale', 'degraded', 'upstreamUnavailable', 'unavailable', 'partial', 'rateLimited'].some(flag => original[flag] === true)
      && !original.error && !['error', 'partial', 'stale', 'unavailable'].some(status => original.status === status);
  }
  const parsed = riskSchema.safeParse(value);
  return parsed.success && parsed.data.countryCode === country
    && (!parsed.data.cii || parsed.data.cii.region === country);
}
