import type { CrossBorderPoint } from '@/services/displacement';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { renderPopupSourceLinks } from './map-popup-source-links';

export function crossBorderMarkerOffsets(points: CrossBorderPoint[]): Map<CrossBorderPoint, [number, number]> {
  const groups = new Map<string, CrossBorderPoint[]>();
  for (const point of points) {
    const key = `${point.lat},${point.lon}`;
    const group = groups.get(key) ?? [];
    group.push(point);
    groups.set(key, group);
  }
  const offsets = new Map<CrossBorderPoint, [number, number]>();
  for (const group of groups.values()) {
    // Keep at least 52 px between coincident markers, including their borders.
    const radius = group.length > 1 ? 26 / Math.sin(Math.PI / group.length) : 0;
    group.forEach((point, index) => {
      const angle = 2 * Math.PI * index / group.length;
      offsets.set(point, [radius * Math.cos(angle), radius * Math.sin(angle)]);
    });
  }
  return offsets;
}

export function createCrossBorderMarker(point: CrossBorderPoint): HTMLButtonElement {
  const death = point.kind === 'death';
  let color = '#b482ff';
  if (death) color = '#e64646';
  else if (point.changePct !== undefined) color = point.changePct >= 0 ? '#f0643c' : '#3cb496';
  else if (point.kind === 'return') color = '#50d28c';
  else if (point.kind === 'arrival') color = '#46b4f0';
  const size = Math.min(40, Math.max(10, Math.sqrt(point.individuals) * 0.5));
  const marker = document.createElement('button');
  marker.type = 'button';
  marker.className = `cross-border-marker cross-border-${death ? 'death' : 'point'}`;
  const hitSize = Math.max(24, size);
  marker.style.cssText = `width:${hitSize}px;height:${hitSize}px;padding:0;border:0;background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;pointer-events:auto`;
  const dot = document.createElement('span');
  dot.className = 'cross-border-dot';
  dot.setAttribute('aria-hidden', 'true');
  dot.style.cssText = `box-sizing:border-box;width:${size}px;height:${size}px;border-radius:50%;color:var(--text-primary);background:${color};border-width:${point.accelerating ? 3 : 1}px;border-style:solid;border-color:${point.accelerating ? '#ff4646' : 'var(--text-primary)'};display:flex;align-items:center;justify-content:center;font-weight:bold`;
  dot.textContent = death ? '×' : '';
  marker.appendChild(dot);
  marker.setAttribute('aria-label', `${point.label}: ${point.individuals.toLocaleString()} · ${point.kind} · ${point.date}`);
  return marker;
}

export function renderCrossBorderDetails(point: CrossBorderPoint): string {
  const period = point.last30Days !== undefined ? '30d' : point.period;
  const change = point.changePct !== undefined ? ` · ${point.changePct > 0 ? '+' : ''}${point.changePct.toFixed(0)}%` : '';
  const stockChange = point.change !== null
    ? `<br>${point.change > 0 ? '+' : ''}${point.change.toLocaleString()}${point.changeSince ? ` ${t('components.deckgl.tooltip.sinceDate', { date: escapeHtml(point.changeSince) })}` : ''}`
    : '';
  return `<strong>${escapeHtml(point.label)}</strong><br>${point.individuals.toLocaleString()} · ${escapeHtml(point.kind)} · ${escapeHtml(point.measure ?? '')}`
    + `${period ? `<br>${escapeHtml(period)}${change}` : ''}`
    + stockChange
    + `<br>${escapeHtml(point.country)} · ${escapeHtml(point.date)}`
    + `<br>${escapeHtml(point.source || t('components.deckgl.tooltip.sourceUnhcrOdp'))}`
    + `${point.accelerating ? `<br><strong>${t('components.displacement.accelerating')}</strong>` : ''}`
    + renderPopupSourceLinks(point.sourceUrl ? [point.sourceUrl] : []);
}
