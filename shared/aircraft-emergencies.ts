export const EMERGENCY_CODES = ['7500', '7600', '7700'] as const;
export type EmergencyCode = typeof EMERGENCY_CODES[number];
export const EMERGENCY_CONDITIONS: Record<EmergencyCode, string> = {
  '7500': 'Unlawful interference signal',
  '7600': 'Radio communication failure signal',
  '7700': 'General emergency signal',
};
export const OBSERVATION_MAX_AGE_MS = 120_000;
export const POSITION_MAX_AGE_MS = 90_000;
export const EMERGENCY_RETENTION_MS = 15 * 60_000;
// Provider, server and browser clocks drift. A report up to this far ahead of
// the local clock is still current; anything further is a bad clock.
export const CLOCK_SKEW_TOLERANCE_MS = 30_000;

export interface EmergencyPosition {
  lat: number;
  lon: number;
  observedAt: number;
}
export interface EmergencyObservation {
  address: string;
  squawk: string;
  source: string;
  observedAt: number;
  position?: EmergencyPosition;
  callsign: string;
  registration: string;
  aircraftType: string;
  description: string;
  militaryFlag: string;
  altitudeFt?: number;
  groundSpeedKts?: number;
}
export interface EmergencyFeed {
  source: string;
  squawk: string;
  status: string;
  fetchedAt: number;
  message: string;
}
export interface EmergencySnapshot {
  observations: EmergencyObservation[];
  feeds: EmergencyFeed[];
}
export interface EmergencyRecord {
  address: string;
  observations: EmergencyObservation[];
  state: 'current' | 'unknown' | 'conflict';
  retainedAt: number;
}
export interface EmergencyMapMarker {
  address: string;
  squawk: string;
  lat: number;
  lon: number;
}

export function isEmergencySquawk(value: unknown): value is EmergencyCode {
  return typeof value === 'string' && EMERGENCY_CODES.includes(value as EmergencyCode);
}

export function isFresh(time: number, now: number, maxAge: number): boolean {
  return Number.isFinite(time) && time > 0 && time <= now + CLOCK_SKEW_TOLERANCE_MS && now - time <= maxAge;
}

export function emergencyMarkerPosition(record: EmergencyRecord, now: number): EmergencyPosition | undefined {
  if (record.state !== 'current') return;
  const observation = record.observations[0];
  const position = observation?.position;
  if (!observation || !isFresh(observation.observedAt, now, OBSERVATION_MAX_AGE_MS)) return;
  if (position && isFresh(position.observedAt, now, POSITION_MAX_AGE_MS)) return position;
}

export function reconcileEmergencies(previous: EmergencyRecord[], snapshot: EmergencySnapshot, now: number, unknownReceipts: Map<string, number>): EmergencyRecord[] {
  const groups = new Map<string, EmergencyObservation[]>();
  const undated = new Set<string>();
  for (const observation of snapshot.observations) {
    if (!isEmergencySquawk(observation.squawk)) continue;
    if (!observation.observedAt) {
      undated.add(observation.address);
      if (!unknownReceipts.has(observation.address)) unknownReceipts.set(observation.address, now);
      if (now - unknownReceipts.get(observation.address)! > EMERGENCY_RETENTION_MS) continue;
    }
    if (observation.observedAt > 0 && now - observation.observedAt > EMERGENCY_RETENTION_MS) continue;
    const group = groups.get(observation.address) ?? [];
    if (!group.some(item => JSON.stringify(item) === JSON.stringify(observation))) group.push(observation);
    groups.set(observation.address, group);
  }
  const complete = EMERGENCY_CODES.every(code => snapshot.feeds.some(feed => feed.squawk === code
    && feed.status === 'available' && isFresh(feed.fetchedAt, now, OBSERVATION_MAX_AGE_MS)));
  for (const address of unknownReceipts.keys()) {
    const reports = groups.get(address);
    if (!undated.has(address) && (reports?.length || complete)) unknownReceipts.delete(address);
  }
  const records = new Map<string, EmergencyRecord>();
  for (const old of previous) {
    const observations = old.observations.filter(item => now - (item.observedAt || unknownReceipts.get(old.address) || old.retainedAt) <= EMERGENCY_RETENTION_MS);
    if (observations.length) records.set(old.address, { ...old, observations, state: 'unknown' });
  }
  for (const [address, observations] of groups) {
    observations.sort((a, b) => b.observedAt - a.observedAt || a.source.localeCompare(b.source) || a.squawk.localeCompare(b.squawk));
    const latest = observations[0]!;
    const prior = records.get(address);
    const priorTime = Math.max(...(prior?.observations.map(item => item.observedAt) ?? [0]));
    if (latest.observedAt > 0 && latest.observedAt < priorTime) continue;
    if (prior?.observations.length && ((!latest.observedAt && priorTime > 0)
      || (latest.observedAt === priorTime && (latest.observedAt > 0 || prior.retainedAt === unknownReceipts.get(address))))) {
      for (const report of prior.observations) {
        if (!observations.some(item => JSON.stringify(item) === JSON.stringify(report))) observations.push(report);
      }
    }
    const anchor = latest.observedAt || unknownReceipts.get(address) || now;
    if (now - anchor > EMERGENCY_RETENTION_MS) continue;
    const conflict = new Set(observations.map(item => item.squawk)).size > 1
      || observations.some(item => item !== latest && item.position && latest.position
        && item.position.observedAt === latest.position.observedAt
        && (item.position.lat !== latest.position.lat || item.position.lon !== latest.position.lon));
    const current = isFresh(latest.observedAt, now, OBSERVATION_MAX_AGE_MS);
    records.set(address, { address, observations, state: conflict ? 'conflict' : current ? 'current' : 'unknown', retainedAt: latest.observedAt ? prior?.retainedAt ?? now : anchor });
  }
  return [...records.values()].sort((a, b) => a.address.localeCompare(b.address));
}
