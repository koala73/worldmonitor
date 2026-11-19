import type { ListUkmtoIncidentsResponse, UkmtoIncident } from '../src/generated/client/worldmonitor/maritime/v1/service_client';

export const UKMTO_SOURCE_URL = 'https://www.ukmto.org/recent-incidents';
// UKMTO blocks automated clients, so reports are collected from this documented republication.
export const UKMTO_REPUBLISHER_URL = 'https://hormuz.data-tracking.net/';
// The republisher refreshes every 30 minutes; one missed collection is still current.
export const UKMTO_FRESH_MS = 75 * 60_000;
export const UKMTO_RETENTION_MS = 24 * 60 * 60_000;
export type UkmtoMapIncident = UkmtoIncident & { stale: boolean };

export function ukmtoIncidentLabel(item: UkmtoMapIncident): string {
  return `UKMTO ${item.incidentNumber} · ${item.incidentType} · ${item.place} · ${new Date(item.occurredAt).toISOString()}${item.stale ? ' · Stale source data' : ''}`;
}

function isIncident(value: unknown): value is UkmtoIncident {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<UkmtoIncident>;
  return typeof row.id === 'string' && row.id.length > 0
    && Number.isInteger(row.incidentNumber) && Number(row.incidentNumber) > 0
    && typeof row.incidentType === 'string' && typeof row.place === 'string' && typeof row.description === 'string'
    && typeof row.occurredAt === 'number' && Number.isFinite(new Date(row.occurredAt).getTime()) && row.occurredAt > 0
    // 0 means the source does not carry a publication time.
    && typeof row.reportedAt === 'number' && Number.isFinite(new Date(row.reportedAt).getTime()) && row.reportedAt >= 0
    && typeof row.location?.latitude === 'number' && Number.isFinite(row.location.latitude) && Math.abs(row.location.latitude) <= 90
    && typeof row.location?.longitude === 'number' && Number.isFinite(row.location.longitude) && Math.abs(row.location.longitude) <= 180;
}

// Browsers pass maxFutureMs = Infinity: a client clock behind the producer must not hide fresh data.
export function readUkmtoSnapshot(value: unknown, now = Date.now(), maxFutureMs = 300_000): ListUkmtoIncidentsResponse {
  const unavailable = { incidents: [], fetchedAt: 0, dataAvailable: false, stale: false };
  if (!value || typeof value !== 'object') return unavailable;
  const data = value as Partial<ListUkmtoIncidentsResponse>;
  if (data.dataAvailable !== true || typeof data.fetchedAt !== 'number' || !Number.isFinite(data.fetchedAt) || data.fetchedAt <= 0
    || now - data.fetchedAt > UKMTO_RETENTION_MS || data.fetchedAt - now > maxFutureMs
    || !Array.isArray(data.incidents) || data.incidents.length > 2000 || !data.incidents.every(isIncident)) return unavailable;
  return {
    incidents: data.incidents, fetchedAt: data.fetchedAt,
    dataAvailable: true, stale: now - data.fetchedAt > UKMTO_FRESH_MS,
  };
}
