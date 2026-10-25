import { z } from 'zod';
import { resolveCountryCode } from './country-code-resolve';
import { countryActivityQueries } from './country-activity-query';
import { COUNTRY_SIGNAL_BYTES, COUNTRY_SIGNAL_FAMILIES, COUNTRY_SIGNAL_WIRE_FAMILIES, type CountrySignalFamily } from './country-signal-contract';
export { COUNTRY_SIGNAL_PATH, COUNTRY_SIGNAL_BYTES, COUNTRY_SIGNAL_FAMILIES, COUNTRY_SIGNAL_WIRE_FAMILIES, type CountrySignalFamily } from './country-signal-contract';
const countryFlightSchema = z.object({
  id: z.string().min(1).max(200), source: z.string().min(1).max(500),
  location: z.object({ latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180) }).optional(),
  firstSeenAt: z.number().finite().nonnegative().optional(), lastSeenAt: z.number().finite().nonnegative().optional(),
}).passthrough();
export const countrySignalResponseSchema = z.object({ countryCode: z.string().regex(/^[A-Z]{2}$/), family: z.enum(COUNTRY_SIGNAL_WIRE_FAMILIES), outcomeJson: z.string().max(COUNTRY_SIGNAL_BYTES).default(''), windowIndex: z.number().int().min(0).max(1).default(0), flightPage: z.object({ flights: z.array(countryFlightSchema).max(100), clusters: z.array(z.object({ id: z.string().max(200), flights: z.array(countryFlightSchema).max(100) }).passthrough()).max(100).default([]), pagination: z.object({ nextCursor: z.string().max(200), totalCount: z.number().int().nonnegative().optional() }).optional() }).optional() }).strict();
export const countrySignalFamilySchema = z.enum([...COUNTRY_SIGNAL_FAMILIES, 'military']);
const clock = z.iso.datetime().nullable();
export const qualifiedObservationSchema = z.object({
  id: z.string().min(1).max(200), family: countrySignalFamilySchema,
  type: z.string().min(1).max(80), severity: z.enum(['critical', 'high', 'medium', 'low']),
  title: z.string().min(1).max(512), source: z.string().min(1).max(500),
  eventAt: clock, snapshotAt: clock,
  timeBasis: z.enum(['event', 'snapshot', 'unknown']),
}).strict();
export const countrySignalOutcomeSchema = z.object({
  countryCode: z.string().regex(/^[A-Z]{2}$/), family: countrySignalFamilySchema,
  state: z.enum(['observed', 'unavailable', 'locked']), observations: z.array(qualifiedObservationSchema).max(100),
  snapshotAt: clock, retrievedAt: z.iso.datetime(), computedAt: clock,
  observationWindow: z.string().max(200).nullable(), scope: z.string().max(500),
  attribution: z.string().max(500), partial: z.boolean(), sampleBeforeCountryFilter: z.boolean(),
  reason: z.string().max(500).nullable(),
  matchedRows: z.number().int().nonnegative().nullable().default(null),
  sampledRows: z.number().int().nonnegative().nullable().default(null),
  omittedRows: z.number().int().nonnegative().nullable().default(null),
}).strict().superRefine((value, ctx) => {
  if (value.state !== 'observed' && value.observations.length) ctx.addIssue({ code: 'custom', message: 'Unavailable source has observations' });
  if (value.observations.some(row => row.family !== value.family)) ctx.addIssue({ code: 'custom', message: 'Observation family mismatch' });
});
export type QualifiedCountryObservation = z.infer<typeof qualifiedObservationSchema>;
export type CountrySignalOutcome = z.infer<typeof countrySignalOutcomeSchema>;
export type QualifiedCountrySignals = {
  countryCode: string; families: CountrySignalOutcome[];
  observations: QualifiedCountryObservation[]; details: QualifiedCountrySignalDetails | null;
};
export type QualifiedCountrySignalDetails = {
  critical: number; high: number; medium: number; low: number;
  recentHigh: Array<{ type: 'MILITARY' | 'PROTEST' | 'CYBER' | 'DISASTER' | 'OUTAGE' | 'OTHER'; severity: QualifiedCountryObservation['severity']; description: string; timestamp: Date | null; source: string }>;
};

export function unavailableCountrySignal(countryCode: string, family: CountrySignalOutcome['family'], reason: string, state: 'unavailable' | 'locked' = 'unavailable'): CountrySignalOutcome {
  return { countryCode, family, state, observations: [], snapshotAt: null, computedAt: null, retrievedAt: new Date().toISOString(), observationWindow: null, scope: 'Source coverage unavailable', attribution: 'Unavailable', partial: true, sampleBeforeCountryFilter: false, reason, matchedRows: null, sampledRows: null, omittedRows: null };
}

export function projectQualifiedCountrySignals(countryCode: string, families: readonly CountrySignalOutcome[]): QualifiedCountrySignals {
  const parsed = families.map(family => countrySignalOutcomeSchema.parse(family));
  if (parsed.some(family => family.countryCode !== countryCode)) throw new Error('Country identity mismatch');
  const postureTypes = new Set(parsed.filter(family => family.family === 'posture' && family.state === 'observed').flatMap(family => family.observations.map(row => row.type)));
  const observations = [...new Map(parsed.filter(family => family.state === 'observed').flatMap(family => family.observations.filter(row => family.family !== 'military' || !postureTypes.has(row.type))).map(row => [`${row.family}:${row.id}`, row])).values()];
  const details: QualifiedCountrySignalDetails | null = parsed.some(family => family.state === 'observed') ? { critical: 0, high: 0, medium: 0, low: 0, recentHigh: [] } : null;
  if (details) {
    for (const row of observations) details[row.severity]++;
    details.recentHigh = observations.filter(row => row.severity === 'critical' || row.severity === 'high')
      .sort((a, b) => (Date.parse(b.eventAt ?? b.snapshotAt ?? '') || 0) - (Date.parse(a.eventAt ?? a.snapshotAt ?? '') || 0) || a.family.localeCompare(b.family) || a.id.localeCompare(b.id))
      .slice(0, 3).map(row => ({ type: row.family === 'military' || row.family === 'posture' || row.family === 'conflict' ? 'MILITARY' : row.family === 'unrest' ? 'PROTEST' : row.family === 'outages' ? 'OUTAGE' : row.family === 'fires' || row.family === 'radiation' ? 'DISASTER' : 'OTHER', severity: row.severity, description: row.title, timestamp: row.eventAt || row.snapshotAt ? new Date((row.eventAt ?? row.snapshotAt)!) : null, source: row.source }));
  }
  return { countryCode, families: parsed, observations, details };
}

export function boundCountrySignalFamily(outcome: CountrySignalOutcome): CountrySignalOutcome {
  const bounded = { ...outcome, observations: outcome.observations.slice(0, 100), partial: outcome.partial || outcome.observations.length > 100 };
  while (new TextEncoder().encode(JSON.stringify(bounded)).length > COUNTRY_SIGNAL_BYTES - 4096 && bounded.observations.length) {
    bounded.observations.pop(); bounded.partial = true;
    if (bounded.sampledRows !== null) bounded.sampledRows = Math.max(0, bounded.sampledRows - 1);
    if (bounded.omittedRows !== null) bounded.omittedRows++;
  }
  return countrySignalOutcomeSchema.parse(bounded);
}

export function projectQualifiedCountrySignalContext(value: QualifiedCountrySignals) {
  const text = (input: string, limit: number) => {
    let result = '';
    for (const scalar of input) {
      if (new TextEncoder().encode(JSON.stringify(result + scalar)).length > limit) break;
      result += scalar;
    }
    return { text: result, truncated: result.length !== input.length };
  };
  return {
    countryCode: value.countryCode,
    details: value.details && { ...value.details, recentHigh: value.details.recentHigh.map(row => ({
      ...row, description: text(row.description, 512), source: text(row.source, 256),
    })) },
    families: value.families.map(({ observations, ...coverage }) => ({
      ...coverage, scope: text(coverage.scope, 256), attribution: text(coverage.attribution, 256),
      reason: coverage.reason === null ? null : text(coverage.reason, 256), includedObservations: observations.length,
    })),
  };
}

export function sourceClock(value: unknown): string | null {
  const millis = typeof value === 'string' && !/^\d+$/.test(value) ? Date.parse(value) : Number(value);
  return Number.isFinite(millis) && millis > 0 && millis <= 8.64e15 ? new Date(millis).toISOString() : null;
}

export function projectCountrySignalFamily(countryCode: string, family: CountrySignalFamily, body: unknown): CountrySignalOutcome {
  const object = z.record(z.string(), z.unknown()).parse(body);
  const outcome: CountrySignalOutcome = { ...unavailableCountrySignal(countryCode, family, ''), state: 'observed', reason: null, partial: false, scope: 'Country-coded observations in the existing source profile', attribution: '', snapshotAt: sourceClock(object.fetchedAt ?? object.scrapedAt), sampleBeforeCountryFilter: family === 'fires' || family === 'radiation' };
  const keys = { outages: 'outages', unrest: 'events', fires: 'fireDetections', radiation: 'observations', sanctions: 'countries', conflict: 'events', posture: 'theaters' } as const;
  const raw = object[keys[family]];
  if (!Array.isArray(raw) || object.dataAvailable === false || (family === 'sanctions' || family === 'conflict') && !outcome.snapshotAt || family === 'posture' && object.state !== 'observed') return unavailableCountrySignal(countryCode, family, family === 'conflict' ? 'Conflict source is disabled or its snapshot is unavailable.' : 'Source snapshot unavailable or unconfirmed.', object.state === 'locked' ? 'locked' : 'unavailable');
  outcome.attribution = { outages: 'Cloudflare Radar', unrest: 'ACLED / GDELT; media-location signals are unverified', fires: 'NASA FIRMS / reporting agency', radiation: 'EPA RadNet / Safecast', sanctions: 'OFAC / Canada SEMA', conflict: 'Existing Iran-events source profile', posture: String(object.provider ?? 'Unknown provider') }[family];
  if (family === 'posture') { outcome.snapshotAt = sourceClock(object.sourceAt); outcome.partial = object.status !== 'live'; outcome.scope = `Redistributable theater posture (${String(object.status)})`; }
  outcome.partial ||= outcome.sampleBeforeCountryFilter;
  let malformedRows = 0;
  for (const value of raw) {
    const parsed = z.record(z.string(), z.unknown()).safeParse(value);
    if (!parsed.success) { outcome.partial = true; malformedRows++; continue; }
    const row = parsed.data;
    const country = row.countryCode ?? row.country;
    if (country != null && typeof country !== 'string') { outcome.partial = true; malformedRows++; continue; }
    const explicit = typeof country === 'string' && country.trim() ? resolveCountryCode(country) : null;
    const location = z.object({ latitude: z.number().finite(), longitude: z.number().finite() }).safeParse(row.location ?? (family === 'conflict' ? row : undefined));
    if (typeof country === 'string' && country.trim()) { if (explicit !== countryCode) continue; }
    else if (family === 'posture') {
      const targets: Record<string, readonly string[]> = { 'iran-theater': ['IR'], 'taiwan-theater': ['TW'], 'korea-theater': ['KP'], 'israel-gaza-theater': ['PS'], 'yemen-redsea-theater': ['YE'] };
      if (!(targets[String(row.theater)] ?? []).includes(countryCode)) continue;
    } else {
      if (!location.success || !countryActivityQueries(countryCode).some(box => location.data.latitude >= box.sw_lat && location.data.latitude <= box.ne_lat && location.data.longitude >= box.sw_lon && location.data.longitude <= box.ne_lon)) continue;
      outcome.scope = 'Coordinate-only records within the fixed country activity viewport; not national territory';
    }
    if (family !== 'sanctions' && family !== 'posture' && (typeof row.id !== 'string' || !row.id.trim())) { outcome.partial = true; malformedRows++; continue; }
    let severity: QualifiedCountryObservation['severity'] = 'low';
    const type = { outages: 'internet_outage', unrest: 'protest', fires: 'satellite_fire', radiation: 'radiation_anomaly', sanctions: 'sanctions_pressure', conflict: 'active_strike', posture: 'military_posture' }[family];
    let title = String(row.title ?? row.locationName ?? row.theater ?? `${family} observation`);
    if (family === 'outages') severity = row.severity === 'OUTAGE_SEVERITY_TOTAL' ? 'high' : row.severity === 'OUTAGE_SEVERITY_MAJOR' ? 'medium' : 'low';
    if (family === 'unrest') { const level = String(row.severity); severity = level.endsWith('_HIGH') || level.endsWith('_CRITICAL') ? 'high' : level.endsWith('_MEDIUM') ? 'medium' : 'low'; }
    if (family === 'fires') { if (typeof row.brightness !== 'number' || !Number.isFinite(row.brightness)) { outcome.partial = true; malformedRows++; continue; } severity = row.brightness > 360 ? 'high' : row.brightness > 320 ? 'medium' : 'low'; title = `Thermal anomaly (${row.brightness}K)`; }
    if (family === 'radiation') {
      const level = String(row.severity);
      if (level.endsWith('_NORMAL') || level.endsWith('_UNSPECIFIED')) continue;
      if (!level.endsWith('_SPIKE') && !level.endsWith('_ELEVATED')) { outcome.partial = true; malformedRows++; continue; }
      severity = level.endsWith('_SPIKE') ? 'critical' : 'medium';
      title = `${level.endsWith('_SPIKE') ? 'Radiation spike' : 'Elevated radiation'} at ${String(row.locationName)}`;
    }
    if (family === 'sanctions') { const entries = row.entryCount, added = row.newEntryCount; if (typeof entries !== 'number' || typeof added !== 'number' || !Number.isInteger(entries) || !Number.isInteger(added) || entries < 0 || added < 0) { outcome.partial = true; malformedRows++; continue; } if (!added && entries < 20) continue; severity = added >= 5 || entries >= 50 ? 'high' : 'medium'; title = `${entries} sanctions designations; ${added} additions since prior snapshot`; }
    if (family === 'conflict') severity = row.severity === 'high' || row.severity === 'critical' ? 'high' : 'low';
    if (family === 'posture') {
      if (row.postureLevel === 'normal') continue;
      if (row.postureLevel !== 'elevated' && row.postureLevel !== 'critical') { outcome.partial = true; malformedRows++; continue; }
      for (const [kind, count] of [['military_flight', row.activeFlights], ['military_vessel', row.trackedVessels]] as const) {
        if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) continue;
        const severity = kind === 'military_vessel' ? (count >= 5 ? 'high' : 'medium') : (row.postureLevel === 'critical' ? 'high' : 'medium');
        outcome.observations.push({ id: `${String(row.theater)}:${kind}`, family, type: kind, severity, title: `${count} ${kind === 'military_flight' ? 'military aircraft' : 'military vessels'} in ${String(row.theater)}`, source: outcome.attribution, eventAt: null, snapshotAt: sourceClock(row.assessedAt) ?? outcome.snapshotAt, timeBasis: sourceClock(row.assessedAt) || outcome.snapshotAt ? 'snapshot' : 'unknown' });
      }
      continue;
    }
    const rawTime = row.detectedAt ?? row.occurredAt ?? row.observedAt ?? row.timestamp;
    const eventAt = sourceClock(family === 'conflict' && Number(rawTime) > 0 && Number(rawTime) < 1e12 ? Number(rawTime) * 1000 : rawTime);
    if (!title.trim() || row.id === '') { outcome.partial = true; malformedRows++; continue; }
    const labels: Record<string, string> = { firms: 'NASA FIRMS', RADIATION_SOURCE_SAFECAST: 'Safecast', RADIATION_SOURCE_EPA_RADNET: 'EPA RadNet', UNREST_SOURCE_TYPE_ACLED: 'ACLED', UNREST_SOURCE_TYPE_GDELT: 'GDELT' };
    if (Array.isArray(row.sources) && (row.sources.length > 16 || row.sources.some(value => typeof value !== 'string'))) outcome.partial = true;
    const rawSource = Array.isArray(row.sources) ? row.sources.filter((value): value is string => typeof value === 'string').slice(0, 16).join(', ') : typeof row.source === 'string' ? row.source : typeof row.sourceType === 'string' ? row.sourceType : outcome.attribution;
    const rowSource = labels[rawSource] ?? rawSource;
    outcome.observations.push({ id: String(row.id ?? row.countryCode ?? row.theater ?? outcome.observations.length).slice(0, 200), family, type, severity, title: title.slice(0, 512), source: (rowSource || outcome.attribution).slice(0, 500), eventAt, snapshotAt: outcome.snapshotAt, timeBasis: eventAt ? 'event' : outcome.snapshotAt ? 'snapshot' : 'unknown' });
  }
  if (raw.length > 0 && malformedRows === raw.length) return unavailableCountrySignal(countryCode, family, 'The source profile contains no valid observations.');
  outcome.observations = [...new Map(outcome.observations.map(row => [row.id, row])).values()].sort((a, b) => (Date.parse(b.eventAt ?? '') || 0) - (Date.parse(a.eventAt ?? '') || 0) || a.id.localeCompare(b.id));
  outcome.matchedRows = outcome.observations.length;
  outcome.sampledRows = Math.min(outcome.matchedRows, family === 'conflict' ? 50 : 100);
  outcome.omittedRows = outcome.matchedRows - outcome.sampledRows;
  if ((family === 'unrest' || family === 'conflict') && outcome.observations.length) {
    const selected = outcome.observations.slice(0, family === 'conflict' ? 50 : 100);
    const high = selected.filter(row => row.severity === 'high').length;
    const severity = family === 'unrest' ? selected.length >= 10 ? 'high' : selected.length >= 5 ? 'medium' : 'low' : high >= 5 ? 'critical' : high >= 2 ? 'medium' : 'low';
    outcome.partial ||= outcome.observations.length > selected.length;
    outcome.observations = [{ ...selected[0]!, id: `${family}:country-summary`, severity, title: `${selected.length} ${family === 'unrest' ? 'unrest' : 'conflict'} observations in the returned source profile`, source: [...new Set(selected.map(row => row.source))].join(', ').slice(0, 500), eventAt: family === 'unrest' ? null : selected[0]!.eventAt, snapshotAt: outcome.snapshotAt, timeBasis: family === 'unrest' ? outcome.snapshotAt ? 'snapshot' : 'unknown' : selected[0]!.eventAt ? 'event' : outcome.snapshotAt ? 'snapshot' : 'unknown' }];
  }
  return boundCountrySignalFamily(outcome);
}
