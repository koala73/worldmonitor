export interface UcdpTabAggregate { count: number; totalDeaths: number }
export type UcdpDedupeIndexEntry = [number, number, number, number, number];

export interface AcledDedupEvent {
  latitude: string | number;
  longitude: string | number;
  event_date: string;
  fatalities: string | number;
  /** Producer id. GDELT unrest is not an ACLED conflict duplicate. */
  source?: string;
  /** ACLED conflict type. Protest/unrest rows are not comparison events. */
  eventType?: string;
}

const ACLED_CONFLICT_EVENT_TYPES = new Set([
  'battle',
  'explosion',
  'remote_violence',
  'violence_against_civilians',
]);

/** True for ACLED conflict rows. Missing source/type stays eligible so legacy fixtures still match. */
export function isAcledConflictComparison(event: AcledDedupEvent): boolean {
  const source = (event.source ?? '').toLowerCase();
  if (source.includes('gdelt')) return false;
  if (event.eventType && !ACLED_CONFLICT_EVENT_TYPES.has(event.eventType)) return false;
  return true;
}

export function toUcdpAcledComparisons(events: ReadonlyArray<{
  lat: number;
  lon: number;
  time: Date;
  fatalities: number;
  source?: string;
  eventType?: string;
}>): AcledDedupEvent[] {
  return events
    .map((event) => ({
      latitude: event.lat,
      longitude: event.lon,
      event_date: event.time.toISOString(),
      fatalities: event.fatalities,
      source: event.source,
      eventType: event.eventType,
    }))
    .filter(isAcledConflictComparison);
}

export interface UcdpDedupCandidate {
  latitude: number;
  longitude: number;
  dateMs: number;
  deathsBest: number;
}

const UCDP_PROTO_VIOLENCE_TYPES = [
  'UCDP_VIOLENCE_TYPE_STATE_BASED',
  'UCDP_VIOLENCE_TYPE_NON_STATE',
  'UCDP_VIOLENCE_TYPE_ONE_SIDED',
] as const;

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function acledMatchesUcdp(ucdp: UcdpDedupCandidate, acled: AcledDedupEvent): boolean {
  const aLat = Number(acled.latitude);
  const aLon = Number(acled.longitude);
  const aDate = new Date(acled.event_date).getTime();
  const aDeaths = Number(acled.fatalities) || 0;

  const dayDiff = Math.abs(ucdp.dateMs - aDate) / (1000 * 60 * 60 * 24);
  if (dayDiff > 7) return false;

  const dist = haversineKm(ucdp.latitude, ucdp.longitude, aLat, aLon);
  if (dist > 50) return false;

  if (ucdp.deathsBest === 0 && aDeaths === 0) return true;
  if (ucdp.deathsBest > 0 && aDeaths > 0) {
    const ratio = ucdp.deathsBest / aDeaths;
    return ratio >= 0.5 && ratio <= 2.0;
  }
  return false;
}

export function isDuplicatedByAcled(ucdp: UcdpDedupCandidate, acledEvents: AcledDedupEvent[]): boolean {
  return acledEvents.some((acled) => isAcledConflictComparison(acled) && acledMatchesUcdp(ucdp, acled));
}

/** Reconcile full-set projection totals with the existing dynamic ACLED de-duplication. */
export function deduplicateUcdpProjectionAggregates(
  aggregates: Record<string, UcdpTabAggregate>,
  dedupeIndex: UcdpDedupeIndexEntry[],
  acledEvents: AcledDedupEvent[],
): Record<string, UcdpTabAggregate> {
  if (!acledEvents.length) return aggregates;

  const reconciled = Object.fromEntries(
    Object.entries(aggregates).map(([type, aggregate]) => [type, { ...aggregate }]),
  ) as Record<string, UcdpTabAggregate>;

  for (const entry of dedupeIndex) {
    const [typeIndex, dateMs, latitude, longitude, deathsBest] = entry;
    const type = UCDP_PROTO_VIOLENCE_TYPES[typeIndex];
    const aggregate = type && reconciled[type];
    if (!aggregate || !isDuplicatedByAcled({ latitude, longitude, dateMs, deathsBest }, acledEvents)) continue;

    aggregate.count = Math.max(0, aggregate.count - 1);
    aggregate.totalDeaths = Math.max(0, aggregate.totalDeaths - deathsBest);
  }

  return reconciled;
}
