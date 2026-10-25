import type { NotamAirspaceKind, NotamAirspaceRestriction } from '@/services/notam-airspace';

// Red for closures and no-go areas, warm tones for restrictions, cool tones
// for activity notices that do not by themselves bar entry.
export const NOTAM_AIRSPACE_COLORS: Record<NotamAirspaceKind, [number, number, number]> = {
  closure: [220, 38, 38],
  tfr: [239, 68, 68],
  prohibited: [190, 18, 60],
  restricted: [249, 115, 22],
  danger: [234, 179, 8],
  military: [168, 85, 247],
  reserved: [59, 130, 246],
  overflight: [14, 165, 233],
};

export const NOTAM_AIRSPACE_KIND_LABELS: Record<NotamAirspaceKind, string> = {
  closure: 'Airspace closed',
  tfr: 'Temporary flight restriction',
  prohibited: 'Prohibited area',
  restricted: 'Restricted area',
  danger: 'Danger area',
  military: 'Military operating area',
  reserved: 'Airspace reservation',
  overflight: 'Overflight restriction',
};

function utc(ms: number | null): string {
  return ms === null ? 'PERM' : `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

/** Tooltip HTML. `text` must HTML-escape: every NOTAM field is upstream data. */
export function notamAirspaceTooltip(row: NotamAirspaceRestriction, text: (value: unknown) => string): string {
  const [r, g, b] = NOTAM_AIRSPACE_COLORS[row.kind] ?? [239, 68, 68];
  const where = row.fir && row.fir !== row.location ? `${row.location} · FIR ${row.fir}` : row.location;
  const limits = row.lower || row.upper ? `<br/>${text(row.lower || 'SFC')} – ${text(row.upper || 'UNL')}` : '';
  const radius = row.radiusNm ? ` · ${text(row.radiusNm)} NM` : '';
  const when = `${row.upcoming ? 'Starts' : 'Active'} ${text(utc(row.startsAt))} → ${text(utc(row.endsAt))}`;
  const schedule = row.schedule ? `<br/>${text(row.schedule)}` : '';
  const body = row.text.length > 220 ? `${row.text.slice(0, 220)}…` : row.text;
  return `<div class="deckgl-tooltip"><strong style="color:rgb(${r},${g},${b});">&#9888; ${text(NOTAM_AIRSPACE_KIND_LABELS[row.kind] ?? 'NOTAM')}</strong>`
    + `<br/>NOTAM ${text(row.number)} · ${text(where)}${radius}${limits}<br/>${when}${schedule}`
    + `<br/><span style="opacity:.75">${text(body)}</span><br/><span style="opacity:.6">Source: FAA NMS</span></div>`;
}
