import { z } from 'zod';
import type { PluginMapLayer } from '../../shared/plugin-news-view';
import type { Earthquake } from '@/services/earthquakes';
import { toNaturalEvent } from '@/services/eonet';
import { toMapFires } from '@/services/wildfires';

const latitude = z.number().finite().min(-90).max(90);
const longitude = z.number().finite().min(-180).max(180);
const timestamp = z.number().positive().refine(value => Number.isFinite(new Date(value).getTime()));
const location = z.object({ latitude, longitude });
const earthquake = z.object({
  id: z.string(), place: z.string(), magnitude: z.number().finite(), depthKm: z.number().finite(),
  location, occurredAt: timestamp, sourceUrl: z.string(), source: z.string(), category: z.string(),
}).passthrough();
const event = z.object({
  id: z.string(), title: z.string(), lat: latitude, lon: longitude, date: timestamp,
  category: z.string(), categoryTitle: z.string(), sourceUrl: z.string(), sourceName: z.string(), closed: z.boolean(),
  description: z.string().optional(), magnitude: z.number().finite().optional(), magnitudeUnit: z.string().optional(),
  stormId: z.string().optional(), stormName: z.string().optional(), basin: z.string().optional(),
  stormCategory: z.number().finite().optional(), classification: z.string().optional(),
  windKt: z.number().finite().optional(), pressureMb: z.number().finite().optional(), movementDir: z.number().finite().optional(), movementSpeedKt: z.number().finite().optional(),
  forecastTrack: z.array(z.object({ lat: latitude, lon: longitude, hour: z.number(), windKt: z.number(), category: z.number() })).optional(),
  conePolygon: z.array(z.object({ points: z.array(z.object({ lat: latitude, lon: longitude })) })).optional(),
  pastTrack: z.array(z.object({ lat: latitude, lon: longitude, windKt: z.number(), timestamp })).optional(),
  canonicalId: z.string().optional(), matchingConfidence: z.string().optional(), canonicalAliases: z.array(z.string()).optional(),
  windAveragingPeriodMinutes: z.number().optional(),
  agencyObservations: z.array(z.object({ agency: z.string(), agencyId: z.string(), observedAt: timestamp, lat: latitude, lon: longitude, status: z.string(), windKt: z.number().optional(), windAveragingPeriodMinutes: z.number().optional(), pressureMb: z.number().optional(), classification: z.string().optional(), sourceName: z.string().optional(), sourceUrl: z.string().optional() })).optional(),
});
const fire = z.object({
  id: z.string(), location, detectedAt: timestamp, brightness: z.number().finite(), frp: z.number().finite(),
  confidence: z.enum(['FIRE_CONFIDENCE_HIGH', 'FIRE_CONFIDENCE_NOMINAL', 'FIRE_CONFIDENCE_LOW', 'FIRE_CONFIDENCE_UNSPECIFIED']),
  region: z.string(), dayNight: z.string(),
}).passthrough();

export interface PluginHazardSnapshot {
  earthquakes?: Earthquake[];
  events?: ReturnType<typeof toNaturalEvent>[];
  fires?: ReturnType<typeof toMapFires>;
  coverage: Record<string, { accepted: number; skipped: number; received: number }>;
  loadedAt: string;
  limitPerSource: number;
}

export async function loadPluginHazardSnapshot(
  layers: readonly PluginMapLayer[],
  callTool: (args: { dataset: string[]; limit: number }) => Promise<unknown>,
): Promise<PluginHazardSnapshot> {
  const dataset = [...(layers.includes('natural') ? ['earthquakes', 'other'] : []), ...(layers.includes('fires') ? ['wildfires'] : [])];
  const budgetEnvelope = z.object({ isError: z.literal(false).optional(), structuredContent: z.object({ _budget_exceeded: z.literal(true) }) });
  for (const limit of [100, 20, 1]) {
    const result = await callTool({ dataset, limit });
    if (!budgetEnvelope.safeParse(result).success) return parsePluginHazardSnapshot(result, layers, limit);
  }
  throw new Error('Hazard snapshot exceeds the tool size limit. Previous map data remains visible.');
}

export function parsePluginHazardSnapshot(result: unknown, layers: readonly PluginMapLayer[], limitPerSource = 100): PluginHazardSnapshot {
  if (result && typeof result === 'object' && 'isError' in result && result.isError) throw new Error('Hazard access was denied or unavailable. Previous map data remains visible.');
  const envelope = z.object({ structuredContent: z.object({ data: z.record(z.string(), z.unknown()) }) }).safeParse(result);
  if (!envelope.success) throw new Error('Hazard data is unavailable. Previous map data remains visible.');
  const response = envelope.data;
  const snapshot: PluginHazardSnapshot = { coverage: {}, loadedAt: new Date().toISOString(), limitPerSource };
  const read = <T>(key: string, field: string, convert: (row: unknown) => T): T[] => {
    const bucket = z.object({ dataAvailable: z.boolean().optional() }).passthrough().safeParse(response.structuredContent.data[key]);
    if (!bucket.success || bucket.data.dataAvailable === false || !Array.isArray(bucket.data[field])) {
      throw new Error(`The ${key} snapshot is unavailable. Previous map data remains visible.`);
    }
    const rows = bucket.data[field] as unknown[];
    const accepted: T[] = [];
    let skipped = 0;
    for (const row of rows.slice(0, limitPerSource)) {
      try { accepted.push(convert(row)); } catch { skipped++; }
    }
    if (rows.length > 0 && accepted.length === 0) throw new Error(`The ${key} snapshot has no valid map locations. Previous map data remains visible.`);
    snapshot.coverage[key] = { accepted: accepted.length, skipped, received: rows.length };
    return accepted;
  };
  if (layers.includes('natural')) {
    snapshot.earthquakes = read('earthquakes', 'earthquakes', row => earthquake.parse(row) as Earthquake);
    snapshot.events = read('events', 'events', row => toNaturalEvent(event.parse(row)));
  }
  if (layers.includes('fires')) {
    snapshot.fires = toMapFires(read('fires', 'fireDetections', row => fire.parse(row)));
  }
  return snapshot;
}
