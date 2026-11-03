import { z } from 'zod';

export const forecastTheaterReadSchema = z.object({}).strict();
const strings = (max: number) => z.array(z.string()).max(max);
const pathSchema = z.object({
  pathId: z.string().min(1), label: z.string(), summary: z.string(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  keyActors: strings(4), keyActorRoles: strings(8).optional(),
}).passthrough();
export const forecastTheatersSchema = z.array(z.object({
  theaterId: z.string().min(1), theaterLabel: z.string(), stateKind: z.string(),
  topPaths: z.array(pathSchema).max(3), dominantReactions: strings(3), stabilizers: strings(3), invalidators: strings(2),
}).passthrough()).max(3).refine(values => new Set(values.map(value => value.theaterId)).size === values.length);

const count = z.number().int().min(0).max(3);
const responseSchema = z.object({
  found: z.boolean(), runId: z.string().max(128), schemaVersion: z.string(), theaterCount: count,
  generatedAt: z.number().int().nonnegative(), note: z.string(), error: z.string(), theaterSummariesJson: z.string(),
  processing: z.boolean(), eligibleTheaterCount: count, failedTheaterCount: count,
  allTheatersFailed: z.boolean(), completionStatus: z.string(),
}).strict();

export const FORECAST_THEATER_STATUSES = ['ready', 'partial', 'empty', 'failed', 'unknown', 'missing', 'processing', 'unavailable'] as const;
export type ForecastTheaterStatus = typeof FORECAST_THEATER_STATUSES[number];
export type ForecastTheaterResult = z.infer<typeof responseSchema> & { status: ForecastTheaterStatus };

export function parseForecastTheaterResult(value: unknown): ForecastTheaterResult | null {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) return null;
  const source = parsed.data;
  let theaters: unknown;
  try { theaters = source.theaterSummariesJson ? JSON.parse(source.theaterSummariesJson) : []; } catch { return null; }
  const nested = forecastTheatersSchema.safeParse(theaters);
  if (!nested.success || nested.data.length !== source.theaterCount) return null;
  if (!source.found) {
    if (source.theaterCount || source.eligibleTheaterCount || source.failedTheaterCount || source.allTheatersFailed || source.completionStatus) return null;
    return { ...source, status: source.error ? 'unavailable' : source.processing ? 'processing' : 'missing' };
  }
  if (!/^\d{13,}-[a-z0-9-]{1,64}$/i.test(source.runId) || !source.generatedAt || source.processing
    || source.theaterCount + source.failedTheaterCount !== source.eligibleTheaterCount
    || source.allTheatersFailed && (source.theaterCount !== 0 || source.failedTheaterCount === 0)) return null;
  let status: ForecastTheaterStatus;
  switch (source.completionStatus) {
    case 'completed':
      if (!source.theaterCount || source.failedTheaterCount || source.allTheatersFailed) return null;
      status = 'ready'; break;
    case 'partial':
      if (!source.theaterCount || !source.failedTheaterCount || source.allTheatersFailed) return null;
      status = 'partial'; break;
    case 'no_eligible_theaters':
      if (source.eligibleTheaterCount || source.allTheatersFailed) return null;
      status = 'empty'; break;
    case 'all_theaters_failed':
      if (source.theaterCount || !source.failedTheaterCount || !source.allTheatersFailed) return null;
      status = 'failed'; break;
    default: status = 'unknown';
  }
  return { ...source, status: source.error ? 'unavailable' : status };
}

export function reusableForecastTheaterResult(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('status' in value)) return false;
  const { status, ...source } = value;
  const result = parseForecastTheaterResult(source);
  return result !== null && result.status === status && (status === 'ready' || status === 'empty') && !result.note;
}

export function unavailableForecastTheaters(error: string): ForecastTheaterResult {
  return { status: 'unavailable', found: false, runId: '', schemaVersion: '', theaterCount: 0, generatedAt: 0,
    note: '', error, theaterSummariesJson: '', processing: false, eligibleTheaterCount: 0, failedTheaterCount: 0,
    allTheatersFailed: false, completionStatus: '' };
}
