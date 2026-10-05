import { z } from 'zod';
import { normalizeAdvisorySnapshot } from './intelligence-snapshots.js';

export const RAW_SIGNAL_FAMILIES = ['earthquakes', 'outages', 'advisories', 'thermal'] as const;
export type RawSignalFamily = typeof RAW_SIGNAL_FAMILIES[number];
export const RAW_SIGNAL_PATH = '/__country-view/signals-raw';
export const RAW_SIGNAL_BODY_BYTES = 524288;
export const RAW_SIGNAL_ENVELOPE_BYTES = 131072;
export const RAW_SIGNAL_READS = {
  earthquakes: '/api/seismology/v1/list-earthquakes?page_size=500',
  outages: '/api/infrastructure/v1/list-internet-outages',
  advisories: '/api/intelligence/v1/list-security-advisories',
  thermal: '/api/thermal/v1/list-thermal-escalations?max_items=12',
} as const;

const text = z.string().min(1);
const date = text.max(100).refine(value => Number.isFinite(Date.parse(value)), 'Invalid observation date');
const millis = z.number().finite().positive().max(8.64e15);
const coordinates = z.object({ latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180) });
const quake = z.object({ id: text.max(200), place: text.max(4096), magnitude: z.number().finite(), location: coordinates, occurredAt: millis, source: text.max(200), category: text.max(200), sourceUrl: z.string().max(2048) });
const outage = z.object({ id: text.max(200), title: text.max(1000), country: text.max(4096), location: coordinates, detectedAt: millis, endedAt: z.number().finite().nonnegative().max(8.64e15).default(0), link: z.string().max(2048) });
const advisory = z.object({ title: text.max(1000), link: text.max(2048), source: text.max(200), sourceCountry: text.max(100), pubDate: date, level: z.enum(['do-not-travel', 'reconsider', 'caution', 'normal', 'info']).default('info'), country: z.string().max(100).default('') });
const thermal = z.object({ id: text.max(200), countryCode: z.string().regex(/^[A-Z]{2}$/), status: z.enum(['normal', 'elevated', 'spike', 'persistent']), firstDetectedAt: date, lastDetectedAt: date });
const profile = {
  earthquakes: { scope: 'Returned global weekly USGS and NRCan earthquake sample, at most 500 events; country matches only.', attribution: 'USGS and Natural Resources Canada (NRCan). Original event times; provider completeness is unknown.', observationWindow: 'Weekly USGS feed and NRCan merge' },
  outages: { scope: 'Curated Cloudflare Radar observations from the 28-day, at most 50-annotation profile; includes ended outages and supported first locations.', attribution: 'Cloudflare Radar Internet outage observations.', observationWindow: '28-day producer profile' },
  advisories: { scope: 'Returned recency-sorted advisory sample, at most 15 rows per publisher; full country index is not counted. Producer success is unknown.', attribution: 'Travel advisory publishers identified on each returned row.', observationWindow: null },
  thermal: { scope: 'First 12 global thermal clusters, then country filter. Reported window is producer metadata; capture time and complete coverage are unknown.', attribution: 'Derived thermal watch combines NASA FIRMS, Canadian Wildland Fire Information System (CWFIS), and British Columbia wildfire inputs.', observationWindow: 'Reported producer window' },
} as const;

function outcomeSchema<T extends z.ZodType>(record: T) {
  return z.object({
    state: z.enum(['observed', 'locked', 'unavailable']), records: z.array(record).nullable(),
    partial: z.boolean(), scope: text.max(500), attribution: text.max(500), snapshotAt: date.nullable(),
    computationAt: date.nullable(), observationWindow: z.string().max(200).nullable(), sourceVersion: z.string().max(100).nullable(),
    retrievedAt: date, reason: z.string().max(400).optional(),
  }).strict().refine(value => value.state === 'observed' ? value.records !== null : value.records === null);
}
export const rawSignalsValueSchema = z.object({
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  sources: z.object({ earthquakes: outcomeSchema(quake), outages: outcomeSchema(outage), advisories: outcomeSchema(advisory), thermal: outcomeSchema(thermal) }).strict(),
  missing: z.array(z.enum(RAW_SIGNAL_FAMILIES)).max(4),
}).strict().superRefine((value, ctx) => {
  for (const family of RAW_SIGNAL_FAMILIES) {
    const source = value.sources[family];
    if (source.state === 'observed' && source.records && ((source.partial || family === 'earthquakes' || family === 'thermal') && !source.records.length || source.records.length > { earthquakes: 500, outages: 50, advisories: 360, thermal: 12 }[family])) ctx.addIssue({ code: 'custom', message: 'Invalid observed sample size' });
    if (family === 'advisories' && source.records) {
      const counts = new Map<string, number>();
      for (const row of source.records) { if ('source' in row) counts.set(row.source, (counts.get(row.source) ?? 0) + 1); }
      if (counts.size > 24 || [...counts.values()].some(count => count > 15)) ctx.addIssue({ code: 'custom', message: 'Invalid per-publisher advisory sample' });
    }
  }
  const missing = RAW_SIGNAL_FAMILIES.filter(family => value.sources[family].state !== 'observed' || value.sources[family].partial);
  if (JSON.stringify(missing) !== JSON.stringify(value.missing)) ctx.addIssue({ code: 'custom', message: 'Signals missing families do not match their outcomes' });
});
export const rawSignalsResultSchema = z.object({
  section: z.literal('signalsRaw'), state: z.enum(['ready', 'locked', 'unavailable']),
  value: rawSignalsValueSchema, retrievedAt: date, reason: z.string().max(400).optional(),
}).strict().superRefine((result, ctx) => {
  const sources = Object.values(result.value.sources);
  const state = sources.some(source => source.state === 'observed') ? 'ready' : sources.every(source => source.state === 'locked') ? 'locked' : 'unavailable';
  if (result.state !== state) ctx.addIssue({ code: 'custom', message: 'Signals state does not match source outcomes' });
});
export type RawSignalsValue = z.infer<typeof rawSignalsValueSchema>;
export type RawSignalsResult = z.infer<typeof rawSignalsResultSchema>;
export type RawSignalOutcome = RawSignalsValue['sources'][RawSignalFamily];

export function failedRawSignal(family: RawSignalFamily, state: 'locked' | 'unavailable', retrievedAt: string, reason: string): RawSignalOutcome {
  return { ...profile[family], state, records: null, partial: false, snapshotAt: null, computationAt: null, sourceVersion: null, retrievedAt, reason };
}

// Called once at the producer-body boundary. Bad rows are disclosed, never silently dropped into an exact count.
export function validateRawSignal(family: RawSignalFamily, body: unknown, retrievedAt: string): RawSignalOutcome {
  const object = z.record(z.string(), z.unknown()).safeParse(body);
  if (!object.success) return failedRawSignal(family, 'unavailable', retrievedAt, 'Malformed source body.');
  const value = object.data;
  const key = family === 'thermal' ? 'clusters' : family;
  const rows = value[key];
  if (!Array.isArray(rows)) return failedRawSignal(family, 'unavailable', retrievedAt, 'Missing source records.');
  if ((family === 'earthquakes' || family === 'thermal') && !rows.length || family === 'thermal' && value.dataAvailable === false) return failedRawSignal(family, 'unavailable', retrievedAt, 'Global empty or unavailable source cannot confirm zero country activity.');
  if (family === 'outages' && rows.length > 50) return failedRawSignal(family, 'unavailable', retrievedAt, 'Outage observations exceed the curated sample limit.');
  if (family === 'advisories') {
    const counts = new Map<string, number>();
    for (const row of rows) if (row && typeof row.source === 'string') counts.set(row.source, (counts.get(row.source) ?? 0) + 1);
    if (rows.length > 360 || counts.size > 24 || [...counts.values()].some(count => count > 15)) return failedRawSignal(family, 'unavailable', retrievedAt, 'Advisory observations exceed the per-publisher sample limit.');
  }
  if (family === 'advisories' && !normalizeAdvisorySnapshot(value)) return failedRawSignal(family, 'unavailable', retrievedAt, 'Advisory snapshot validation failed.');
  const metadata = family === 'thermal' ? z.object({ fetchedAt: date, sourceVersion: text.max(100), dataAvailable: z.boolean().optional(), observationWindowHours: z.number().finite().positive() }).safeParse(value) : undefined;
  if (metadata && !metadata.success) return failedRawSignal(family, 'unavailable', retrievedAt, 'Missing thermal computation metadata.');
  const schema = { earthquakes: quake, outages: outage, advisories: advisory, thermal }[family];
  const selected = family === 'thermal' ? rows.slice(0, 12) : family === 'earthquakes' ? rows.slice(0, 500) : rows;
  const parsed = selected.map(row => schema.safeParse(family === 'thermal' && row && typeof row === 'object' ? { ...row, status: typeof row.status === 'string' ? row.status.replace('THERMAL_STATUS_', '').toLowerCase() : row.status } : row));
  const records = parsed.flatMap(result => result.success ? [result.data] : []);
  const partial = parsed.some(result => !result.success);
  if (partial && !records.length) return failedRawSignal(family, 'unavailable', retrievedAt, 'All returned records are malformed.');
  return { ...profile[family], state: 'observed', records, partial, snapshotAt: null, retrievedAt,
    computationAt: metadata?.success ? metadata.data.fetchedAt : null, sourceVersion: metadata?.success ? metadata.data.sourceVersion : null,
    observationWindow: metadata?.success ? `${metadata.data.observationWindowHours} hours (reported)` : profile[family].observationWindow,
    ...(partial ? { reason: 'Malformed rows make the exact country count unknown. Partial evidence is retryable.' } : {}),
  } as RawSignalOutcome;
}

export function assembleRawSignals(countryCode: string, sources: RawSignalsValue['sources'], retrievedAt: string): RawSignalsResult {
  const outcomes = Object.values(sources);
  return { section: 'signalsRaw', state: outcomes.some(source => source.state === 'observed') ? 'ready' : outcomes.every(source => source.state === 'locked') ? 'locked' : 'unavailable',
    value: { countryCode, sources, missing: RAW_SIGNAL_FAMILIES.filter(family => sources[family].state !== 'observed' || sources[family].partial) }, retrievedAt };
}

export function projectRawSignals(value: RawSignalsValue, countryName: string, hasGeography: boolean, contains: (lat: number, lon: number) => boolean) {
  const { sources, countryCode } = value;
  const exact = (source: RawSignalOutcome) => source.state === 'observed' && !source.partial;
  const earthquakes = exact(sources.earthquakes) ? sources.earthquakes.records!.filter(row => hasGeography ? contains(row.location.latitude, row.location.longitude) : row.place.toLowerCase().includes(countryName.toLowerCase())).length : null;
  const outages = exact(sources.outages) ? sources.outages.records!.filter(row => row.country.toLowerCase() === countryName.toLowerCase() || hasGeography && contains(row.location.latitude, row.location.longitude)).length : null;
  const rows = exact(sources.advisories) ? sources.advisories.records!.filter(row => row.country === countryCode) : null;
  const rank: Record<string, number> = { 'do-not-travel': 4, reconsider: 3, caution: 2, normal: 1, info: 0 };
  let travelAdvisoryMaxLevel: string | null = null;
  for (const row of rows ?? []) if ((rank[row.level] ?? 0) > (rank[travelAdvisoryMaxLevel ?? ''] ?? 0)) travelAdvisoryMaxLevel = row.level;
  const thermalEscalations = exact(sources.thermal) ? sources.thermal.records!.filter(row => row.countryCode === countryCode && row.status !== 'normal').length : null;
  return { earthquakes, outages, travelAdvisories: rows?.length ?? null, travelAdvisoryMaxLevel, thermalEscalations };
}
