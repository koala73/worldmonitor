import { geoInterpolate } from 'd3';
import type { DisplacementFlow, DisplacementEventsData, InternalDisplacementData } from '@/services/displacement';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';

/** A located figure or route; source counts remain separate. */
export interface DisplacementMarker {
  kind: 'unhcr' | 'dtm-region' | 'dtm-route' | 'idmc';
  lat: number;
  lon: number;
  count: number;
  color: string;
  title: string;
  label: string;
  context: string[];
  source: string;
  route?: [[number, number], [number, number]];
}

const validPosition = (lat: unknown, lon: unknown): boolean =>
  typeof lat === 'number' && Number.isFinite(lat) && Math.abs(lat) <= 90
  && typeof lon === 'number' && Number.isFinite(lon) && Math.abs(lon) <= 180;
const validCount = (count: number): boolean => Number.isFinite(count) && count > 0;

function routeMarker(
  marker: Omit<DisplacementMarker, 'lat' | 'lon' | 'route'>,
  originLat: number | undefined, originLon: number | undefined,
  destinationLat: number | undefined, destinationLon: number | undefined,
): DisplacementMarker[] {
  if (!validCount(marker.count) || !validPosition(originLat, originLon) || !validPosition(destinationLat, destinationLon)) return [];
  const route: DisplacementMarker['route'] = [[originLon!, originLat!], [destinationLon!, destinationLat!]];
  const [lon, lat] = geoInterpolate(route[0], route[1])(0.5);
  return [{ ...marker, lat, lon, route }];
}

export function displacementFlowMarkers(flows: DisplacementFlow[]): DisplacementMarker[] {
  // Match the desktop's top-50 UNHCR routes. These are refugee stocks by
  // origin/asylum country, not dated movements or arrival counts.
  return flows.filter(f => validPosition(f.originLat, f.originLon) && validPosition(f.asylumLat, f.asylumLon) && validCount(f.refugees))
    .slice(0, 50).flatMap(f => routeMarker({
      kind: 'unhcr', count: f.refugees, color: '#6496ff', title: `${f.originName} → ${f.asylumName}`,
      label: t('components.displacement.refugees'), context: [], source: 'UNHCR',
    }, f.originLat, f.originLon, f.asylumLat, f.asylumLon));
}

export function internalDisplacementMarkers(data: InternalDisplacementData): DisplacementMarker[] {
  const source = t('components.deckgl.tooltip.sourceIomDtm');
  const label = t('components.deckgl.tooltip.internallyDisplaced');
  return [
    ...data.routes.flatMap(r => routeMarker({
      kind: 'dtm-route', count: r.idps, color: '#b482ff', title: `${r.originName} → ${r.destinationName}`,
      label, source, context: [r.countryName, r.operation, r.reportingDate],
    }, r.originLat, r.originLon, r.destinationLat, r.destinationLon)),
    ...data.regions.filter(r => validPosition(r.lat, r.lon) && validCount(r.idps)).map(r => ({
      kind: 'dtm-region' as const, lat: r.lat, lon: r.lon, count: r.idps, color: '#b482ff',
      title: `${r.name}, ${r.countryName}`, label, source, context: [r.operation, r.reportingDate],
    })),
  ];
}

export function displacementEventMarkers(data: DisplacementEventsData): DisplacementMarker[] {
  return data.points.filter(p => validPosition(p.lat, p.lon) && validCount(p.figure)).map(p => ({
    kind: 'idmc', lat: p.lat, lon: p.lon, count: p.figure,
    color: p.conflict ? '#e65a46' : '#4696e6', title: `${p.locationName || p.countryName}`,
    label: t('components.deckgl.tooltip.displaced'), source: t('components.deckgl.tooltip.sourceIdmc'),
    context: [p.eventName, p.conflict ? t('components.displacement.conflict') : p.hazardType, p.displacementDate],
  }));
}

export function createDisplacementMarker(item: DisplacementMarker): HTMLButtonElement {
  const marker = document.createElement('button');
  marker.type = 'button';
  marker.className = `displacement-marker displacement-${item.kind}`;
  marker.setAttribute('aria-label', `${item.title}: ${item.count.toLocaleString()} ${item.label} · ${item.source}`);
  // Preserve a 24px tap target even for a small figure. The dot's area scales
  // with people; routes use a diamond to distinguish them from local figures.
  const size = Math.min(36, Math.max(8, Math.sqrt(item.count) * 0.12));
  marker.style.cssText = `width:${Math.max(24, size)}px;height:${Math.max(24, size)}px;padding:0;border:0;background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;pointer-events:auto`;
  const dot = document.createElement('span');
  dot.setAttribute('aria-hidden', 'true');
  dot.style.cssText = `width:${size}px;height:${size}px;box-sizing:border-box;border:1px solid var(--text-primary);background:${item.color};opacity:.85;border-radius:${item.route ? '2px' : '50%'};${item.route ? 'transform:rotate(45deg)' : ''}`;
  marker.appendChild(dot);
  return marker;
}

export function renderDisplacementDetails(item: DisplacementMarker): string {
  return `<strong>${escapeHtml(item.title)}</strong><br>${item.count.toLocaleString()} ${escapeHtml(item.label)}`
    + item.context.filter(Boolean).map(line => `<br>${escapeHtml(line)}`).join('')
    + `<br>${escapeHtml(item.source)}`;
}
