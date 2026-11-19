import { geoInterpolate } from 'd3';
import type { DisplacementFlow, DisplacementEventsData, InternalDisplacementData } from '@/services/displacement';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';

/** One labelled fact shown in the popup's stats grid. */
export interface DisplacementDetail {
  label: string;
  value: string;
}

/** A located figure or route; source counts remain separate. */
export interface DisplacementMarker {
  kind: 'unhcr' | 'dtm-region' | 'dtm-route' | 'idmc';
  /** Popup badge; its colour matches the marker. */
  badge: 'refugees' | 'idps' | 'conflict' | 'disaster';
  lat: number;
  lon: number;
  count: number;
  color: string;
  title: string;
  label: string;
  details: DisplacementDetail[];
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
      kind: 'unhcr', badge: 'refugees', count: f.refugees, color: '#6496ff', title: `${f.originName} → ${f.asylumName}`,
      label: t('components.displacement.refugees'), details: [], source: 'UNHCR',
    }, f.originLat, f.originLon, f.asylumLat, f.asylumLon));
}

/** Labelled details, dropping any the source left empty. */
function details(...rows: Array<[label: string, value: string | undefined]>): DisplacementDetail[] {
  return rows.filter(([, value]) => Boolean(value)).map(([label, value]) => ({ label, value: value! }));
}

export function internalDisplacementMarkers(data: InternalDisplacementData): DisplacementMarker[] {
  const source = t('components.deckgl.tooltip.sourceIomDtm');
  const label = t('components.deckgl.tooltip.internallyDisplaced');
  const operation = t('popups.displacement.operation');
  const reportDate = t('popups.displacement.reportDate');
  return [
    ...data.routes.flatMap(r => routeMarker({
      kind: 'dtm-route', badge: 'idps', count: r.idps, color: '#b482ff', title: `${r.originName} → ${r.destinationName}`,
      label, source, details: details([t('components.displacement.country'), r.countryName], [operation, r.operation], [reportDate, r.reportingDate]),
    }, r.originLat, r.originLon, r.destinationLat, r.destinationLon)),
    ...data.regions.filter(r => validPosition(r.lat, r.lon) && validCount(r.idps)).map(r => ({
      kind: 'dtm-region' as const, badge: 'idps' as const, lat: r.lat, lon: r.lon, count: r.idps, color: '#b482ff',
      title: `${r.name}, ${r.countryName}`, label, source, details: details([operation, r.operation], [reportDate, r.reportingDate]),
    })),
  ];
}

export function displacementEventMarkers(data: DisplacementEventsData): DisplacementMarker[] {
  return data.points.filter(p => validPosition(p.lat, p.lon) && validCount(p.figure)).map(p => ({
    kind: 'idmc', badge: p.conflict ? 'conflict' : 'disaster', lat: p.lat, lon: p.lon, count: p.figure,
    color: p.conflict ? '#e65a46' : '#4696e6', title: `${p.locationName || p.countryName}`,
    label: t('components.deckgl.tooltip.displaced'), source: t('components.deckgl.tooltip.sourceIdmc'),
    details: details(
      [t('popups.displacement.event'), p.eventName],
      [t('popups.displacement.cause'), p.conflict ? t('components.displacement.conflict') : p.hazardType],
      [t('popups.displacement.date'), p.displacementDate],
    ),
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

const BADGE_LABEL_KEYS: Record<DisplacementMarker['badge'], string> = {
  refugees: 'components.displacement.refugees',
  idps: 'components.displacement.idps',
  conflict: 'components.displacement.conflict',
  disaster: 'components.displacement.disaster',
};

const sentenceCase = (text: string): string => text.charAt(0).toLocaleUpperCase() + text.slice(1);

/** One cell of the shared `.popup-stats` grid; both arguments are escaped here. */
export function popupStat(label: string, value: string): string {
  return `<div class="popup-stat"><span class="stat-label">${escapeHtml(label)}</span><span class="stat-value">${escapeHtml(value)}</span></div>`;
}

/** The map popup of a displacement figure, in the layout every map popup shares. */
export function renderDisplacementPopup(item: DisplacementMarker): string {
  return `
    <div class="popup-header displacement">
      <span class="popup-title">${escapeHtml(t('panels.displacement').toLocaleUpperCase())}</span>
      <span class="popup-badge displacement-${item.badge}">${escapeHtml(t(BADGE_LABEL_KEYS[item.badge]).toLocaleUpperCase())}</span>
      <button class="popup-close" aria-label="${escapeHtml(t('common.close'))}">×</button>
    </div>
    <div class="popup-body">
      <p class="popup-location">${escapeHtml(item.title)}</p>
      <div class="popup-stats">
        ${popupStat(sentenceCase(item.label), item.count.toLocaleString())}
        ${item.details.map(detail => popupStat(detail.label, detail.value)).join('')}
      </div>
      <div class="popup-attribution">${escapeHtml(item.source)}</div>
    </div>`;
}
