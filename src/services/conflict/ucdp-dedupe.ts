export interface UcdpTabAggregate { count: number; totalDeaths: number }
export type UcdpDedupeIndexEntry = [number, number, number, number, number];

export interface AcledDedupEvent {
  latitude: string | number;
  longitude: string | number;
  event_date: string;
  fatalities: string | number;
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

function validCoordinates(latitude: number, longitude: number): boolean {
  return Number.isFinite(latitude) && Math.abs(latitude) <= 90
    && Number.isFinite(longitude) && Math.abs(longitude) <= 180;
}

function numericValue(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number') return NaN;
  return typeof value === 'string' && !value.trim() ? NaN : Number(value);
}

export function isDuplicatedByAcled(ucdp: UcdpDedupCandidate, acledEvents: AcledDedupEvent[]): boolean {
  if (!validCoordinates(ucdp.latitude, ucdp.longitude) || !Number.isFinite(ucdp.dateMs)
    || !Number.isFinite(ucdp.deathsBest) || ucdp.deathsBest < 0) return false;

  for (const acled of acledEvents) {
    const aLat = numericValue(acled.latitude);
    const aLon = numericValue(acled.longitude);
    const aDate = new Date(acled.event_date).getTime();
    const aDeaths = numericValue(acled.fatalities);
    if (!validCoordinates(aLat, aLon) || !Number.isFinite(aDate)
      || !Number.isFinite(aDeaths) || aDeaths < 0) continue;

    const dayDiff = Math.abs(ucdp.dateMs - aDate) / (1000 * 60 * 60 * 24);
    if (dayDiff > 7) continue;

    const dist = haversineKm(ucdp.latitude, ucdp.longitude, aLat, aLon);
    if (dist > 50) continue;

    if (ucdp.deathsBest === 0 && aDeaths === 0) return true;
    if (ucdp.deathsBest > 0 && aDeaths > 0) {
      const ratio = ucdp.deathsBest / aDeaths;
      if (ratio >= 0.5 && ratio <= 2.0) return true;
    }
  }
  return false;
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
