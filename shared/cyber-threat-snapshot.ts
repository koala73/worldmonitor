import type { ListCyberThreatsResponse } from '../src/generated/client/worldmonitor/cyber/v1/service_client';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTimestamp(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8.64e15;
}

/** Accept empty snapshots, but reject entries that cannot safely reach the map adapter. */
export function isCyberThreatSnapshot(value: unknown): value is Pick<ListCyberThreatsResponse, 'threats'> {
  if (!isRecord(value) || !Array.isArray(value.threats)) return false;
  return value.threats.every((threat: unknown) => {
    if (!isRecord(threat)) return false;
    if (!['id', 'indicator', 'type', 'source', 'indicatorType', 'severity'].every(
      key => typeof threat[key] === 'string' && threat[key].length > 0,
    )) return false;
    if (!Array.isArray(threat.tags) || !threat.tags.every(tag => typeof tag === 'string')) return false;
    if (!isTimestamp(threat.firstSeenAt) || !isTimestamp(threat.lastSeenAt)) return false;
    if (!['country', 'malwareFamily'].every(key => threat[key] === undefined || typeof threat[key] === 'string')) return false;
    const location = threat.location;
    return location === undefined || (isRecord(location)
      && typeof location.latitude === 'number' && Number.isFinite(location.latitude) && Math.abs(location.latitude) <= 90
      && typeof location.longitude === 'number' && Number.isFinite(location.longitude) && Math.abs(location.longitude) <= 180);
  });
}
