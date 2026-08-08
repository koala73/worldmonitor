// Shared formatter for the energy-disruption timeline used by
// PipelineStatusPanel and StorageFacilityMapPanel drawers.
//
// Kept dependency-free (no generated type imports, no DOM) so the panels
// can assemble HTML with their existing escape/sanitize helpers. Both
// drawers call renderDisruptionList on the same shape and get a
// consistent UI.

export interface DisruptionSourceInput {
  authority?: string;
  title?: string;
  url?: string;
  date?: string;
  sourceType?: string;
}

export interface DisruptionEventInput {
  id?: string;
  eventType?: string;
  startAt?: string;
  endAt?: string;
  capacityOfflineBcmYr?: number;
  capacityOfflineMbd?: number;
  causeChain?: ReadonlyArray<string>;
  shortDescription?: string;
  sources?: ReadonlyArray<DisruptionSourceInput>;
}

export function formatEventWindow(start: string | undefined, end: string | undefined): string {
  const startDay = (start || '').slice(0, 10);
  const endDay = (end || '').slice(0, 10);
  if (!startDay) return 'date unknown';
  if (!endDay) return `${startDay} · ongoing`;
  if (endDay === startDay) return startDay;
  return `${startDay} → ${endDay}`;
}

export function formatCapacityOffline(
  bcmYr: number | undefined,
  mbd: number | undefined,
): string {
  const parts: string[] = [];
  if (typeof bcmYr === 'number' && bcmYr > 0) parts.push(`${bcmYr.toFixed(1)} bcm/yr`);
  if (typeof mbd === 'number' && mbd > 0) parts.push(`${mbd.toFixed(2)} mb/d`);
  return parts.length > 0 ? parts.join(' · ') : '';
}

export type DisruptionStatus = 'ongoing' | 'resolved' | 'unknown';

export function statusForEvent(event: DisruptionEventInput): DisruptionStatus {
  if (!event.startAt) return 'unknown';
  return event.endAt ? 'resolved' : 'ongoing';
}
