export interface CanadaRoadRecord {
  id: string;
  kind?: 'event' | 'alert' | 'condition';
  lat: number | null;
  lon: number | null;
  centroid?: [number, number] | null;
  severity: string;
  eventType: string;
  type?: string;
  isFullClosure: boolean;
  lanesAffected: string | null;
  roadwayName?: string;
  headline: string;
  description: string;
  path?: [number, number][] | null;
  jurisdiction: string;
  resource?: string;
  source?: string;
  district?: string | null;
  currImpact?: string | null;
  createdTime?: number | null;
  lastUpdated?: number | null;
  startTime?: number | null;
  endTime?: number | null;
}

export type CanadaRoadSourceState = 'available' | 'empty' | 'unavailable' | 'malformed';

export interface CanadaRoadSourceDescriptor {
  key: string;
  source: string;
  jurisdiction: string;
}

/**
 * The five road feeds that union onto the `canadaRoads` map layer.
 *
 * Declared here rather than in `canada-roads.ts` so tests can assert against the
 * real descriptors: that module reaches Vite-side imports (`import.meta.env`),
 * so a test importing it has to fall back to reading source text or cloning this
 * list — and a cloned copy cannot fail when the real one changes.
 *
 * Every source is an on-demand bootstrap key (#6763). None of them rides a
 * tier, so a visitor who leaves the layer off never downloads any of it —
 * which is the whole reason the layer can ship disabled by default.
 *
 * Whether a key is on-demand is NOT restated here. `bootstrapTierKeyNames`
 * (shared/bootstrap-tier-keys.js) is the single source of truth, and a copy in
 * this list would only give the two somewhere to disagree — the descriptor
 * carried a stale `onDemand: false` for both 511 feeds right up to #6763.
 */
export const CANADA_ROAD_SOURCES: readonly CanadaRoadSourceDescriptor[] = Object.freeze([
  { key: 'canadaRoads', source: 'ontario-511', jurisdiction: 'ON' },
  { key: 'albertaRoads', source: 'alberta-511', jurisdiction: 'AB' },
  { key: 'manitobaRoads', source: 'manitoba-511', jurisdiction: 'MB' },
  { key: 'torontoRoads', source: 'toronto-roads', jurisdiction: 'Toronto' },
  { key: 'bcOpen511', source: 'bc-open511', jurisdiction: 'BC' },
]);

export type CanadaRoadSourceStates = Record<string, CanadaRoadSourceState>;

export function hasHealthyCanadaRoadSource(states: CanadaRoadSourceStates): boolean {
  return Object.values(states).some((state) => state === 'available' || state === 'empty');
}

function isCanadaRoadRecord(value: unknown): value is CanadaRoadRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<CanadaRoadRecord>;
  const validPosition = (position: unknown): position is [number, number] => Array.isArray(position)
    && position.length === 2
    && position.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate));
  const validOptionalString = (field: unknown) => field === undefined || typeof field === 'string';
  const validNullableString = (field: unknown) => field === undefined || field === null || typeof field === 'string';
  const validNullableNumber = (field: unknown) => field === undefined
    || field === null
    || (typeof field === 'number' && Number.isFinite(field));
  return typeof record.id === 'string'
    && record.id.trim().length > 0
    && (record.lat === null || (typeof record.lat === 'number' && Number.isFinite(record.lat)))
    && (record.lon === null || (typeof record.lon === 'number' && Number.isFinite(record.lon)))
    && typeof record.severity === 'string'
    && typeof record.eventType === 'string'
    && typeof record.isFullClosure === 'boolean'
    && (record.lanesAffected === null || typeof record.lanesAffected === 'string')
    && typeof record.headline === 'string'
    && typeof record.description === 'string'
    && typeof record.jurisdiction === 'string'
    && (record.kind === undefined || ['event', 'alert', 'condition'].includes(record.kind))
    && validOptionalString(record.type)
    && validOptionalString(record.roadwayName)
    && validOptionalString(record.resource)
    && validOptionalString(record.source)
    && validNullableString(record.district)
    && validNullableString(record.currImpact)
    && (record.centroid === undefined || record.centroid === null || validPosition(record.centroid))
    && (record.path === undefined || record.path === null
      || (Array.isArray(record.path) && record.path.every(validPosition)))
    && validNullableNumber(record.createdTime)
    && validNullableNumber(record.lastUpdated)
    && validNullableNumber(record.startTime)
    && validNullableNumber(record.endTime);
}

function validatedRecords(value: unknown): CanadaRoadRecord[] | null {
  if (!Array.isArray(value)) return null;
  return value.every(isCanadaRoadRecord) ? value : null;
}

export function recordsFromPayload(payload: unknown): CanadaRoadRecord[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = payload as {
    records?: CanadaRoadRecord[];
    events?: CanadaRoadRecord[];
    alerts?: CanadaRoadRecord[];
    conditions?: CanadaRoadRecord[];
    data?: unknown;
  };
  if (value.data && typeof value.data === 'object' && value.data !== value) {
    const nested = recordsFromPayload(value.data);
    if (nested) return nested;
  }
  if (Array.isArray(value.records)) return validatedRecords(value.records);
  const eventRecords = Array.isArray(value.events) ? validatedRecords(value.events) : [];
  const alertRecords = Array.isArray(value.alerts) ? validatedRecords(value.alerts) : [];
  const conditionRecords = Array.isArray(value.conditions) ? validatedRecords(value.conditions) : [];
  if (eventRecords == null || alertRecords == null || conditionRecords == null) return null;
  const combined = [
    ...eventRecords,
    ...alertRecords,
    ...conditionRecords,
  ];
  const hasKnownArray = Array.isArray(value.events)
    || Array.isArray(value.alerts)
    || Array.isArray(value.conditions);
  return combined.length || hasKnownArray ? combined : null;
}

function stampSource(
  records: CanadaRoadRecord[] | null,
  source: string,
  jurisdiction: string,
): CanadaRoadRecord[] | null {
  if (!records) return null;
  return records.map((record) => ({
    ...record,
    source: record.source || source,
    jurisdiction: record.jurisdiction || jurisdiction,
  }));
}

export function unionCanadaRoadRecords(
  ...groups: Array<CanadaRoadRecord[] | null>
): CanadaRoadRecord[] | null {
  const present = groups.filter((group): group is CanadaRoadRecord[] => group != null);
  if (present.length === 0) return null;
  const seen = new Set<string>();
  const out: CanadaRoadRecord[] = [];
  for (const group of present) {
    for (const record of group) {
      const id = `${record.source || record.jurisdiction || ''}:${record.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(record);
    }
  }
  return out;
}

export interface CanadaRoadCoreDependencies {
  getHydrated: (key: string) => unknown | undefined;
  fetchMissing: (descriptor: CanadaRoadSourceDescriptor) => Promise<unknown | undefined>;
}

export async function loadCanadaRoadSourcesCore(
  descriptors: readonly CanadaRoadSourceDescriptor[],
  dependencies: CanadaRoadCoreDependencies,
): Promise<{ records: CanadaRoadRecord[] | null; states: CanadaRoadSourceStates }> {
  const settled = await Promise.allSettled(descriptors.map(async (descriptor) => {
    const hydrated = dependencies.getHydrated(descriptor.key);
    const payload = hydrated !== undefined
      ? hydrated
      : await dependencies.fetchMissing(descriptor);
    if (payload == null) return { records: null, state: 'unavailable' as const };
    const records = stampSource(
      recordsFromPayload(payload),
      descriptor.source,
      descriptor.jurisdiction,
    );
    if (records == null) return { records, state: 'malformed' as const };
    return {
      records,
      state: records.length > 0 ? 'available' as const : 'empty' as const,
    };
  }));

  const states: CanadaRoadSourceStates = {};
  const groups: Array<CanadaRoadRecord[] | null> = [];
  settled.forEach((result, index) => {
    const descriptor = descriptors[index];
    if (!descriptor) return;
    if (result.status === 'rejected') {
      states[descriptor.key] = 'unavailable';
      groups.push(null);
      return;
    }
    states[descriptor.key] = result.value.state;
    groups.push(result.value.records);
  });
  return { records: unionCanadaRoadRecords(...groups), states };
}
