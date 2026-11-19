import { ensureHydrated } from '@/services/bootstrap';

// One row of aviation:notam:airspace:v1, written by scripts/seed-notam-nms.mjs
// (buildAirspace in scripts/lib/nms-notam.mjs). Times are epoch ms; a null end
// is a permanent NOTAM.
export type NotamAirspaceKind = 'closure' | 'tfr' | 'prohibited' | 'restricted' | 'danger' | 'military' | 'reserved' | 'overflight';

export interface NotamAirspaceRestriction {
  id: string;
  kind: NotamAirspaceKind;
  location: string;
  fir?: string;
  number: string;
  qcode: string;
  startsAt: number | null;
  endsAt: number | null;
  upcoming?: boolean;
  schedule?: string;
  lower?: string;
  upper?: string;
  /** [lon, lat] */
  center: [number, number];
  radiusNm?: number;
  /** Outer rings, each a closed list of [lon, lat]. */
  polygons?: [number, number][][];
  text: string;
}

export interface NotamAirspaceSnapshot {
  generatedAt: number | null;
  notams: NotamAirspaceRestriction[];
}

const KINDS = new Set<NotamAirspaceKind>(['closure', 'tfr', 'prohibited', 'restricted', 'danger', 'military', 'reserved', 'overflight']);

function isPosition(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length >= 2
    && typeof value[0] === 'number' && Number.isFinite(value[0]) && Math.abs(value[0]) <= 180
    && typeof value[1] === 'number' && Number.isFinite(value[1]) && Math.abs(value[1]) <= 90;
}

function isRestriction(value: unknown): value is NotamAirspaceRestriction {
  const row = value as Partial<NotamAirspaceRestriction> | null;
  return !!row && typeof row.id === 'string' && KINDS.has(row.kind as NotamAirspaceKind) && isPosition(row.center)
    && typeof row.text === 'string';
}

/** Validate the seeded payload; malformed rows are dropped, not rendered. */
export function parseNotamAirspace(value: unknown): NotamAirspaceSnapshot {
  const payload = value as { generatedAt?: unknown; notams?: unknown } | null | undefined;
  const rows = Array.isArray(payload?.notams) ? payload.notams.filter(isRestriction) : [];
  return {
    generatedAt: typeof payload?.generatedAt === 'number' ? payload.generatedAt : null,
    notams: rows.map((row) => ({
      ...row,
      polygons: Array.isArray(row.polygons) ? row.polygons.filter((ring) => Array.isArray(ring) && ring.length >= 4 && ring.every(isPosition)) : undefined,
    })),
  };
}

/**
 * Rows still in effect at `nowMs`, with `upcoming` re-derived from the clock.
 * The seeder computes both at publish time, but the client can hold a snapshot
 * for hours (a failed refresh keeps the last one, and the seeder keeps
 * last-good alive while NMS is down), so an ended NOTAM must not stay drawn.
 */
export function currentRestrictions(rows: NotamAirspaceRestriction[], nowMs: number): NotamAirspaceRestriction[] {
  return rows
    .filter((row) => row.endsAt === null || row.endsAt > nowMs)
    .map((row) => ({ ...row, upcoming: row.startsAt !== null && row.startsAt > nowMs }));
}

/**
 * The on-demand key is fetched only while the layer is on. Undefined means
 * the fetch failed (or the key is not published yet), not "no restrictions".
 */
export async function fetchNotamAirspace(): Promise<NotamAirspaceSnapshot | undefined> {
  const value = await ensureHydrated('notamAirspace');
  return value === undefined ? undefined : parseNotamAirspace(value);
}
