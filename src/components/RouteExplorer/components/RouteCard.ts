/**
 * Shared route-card component for Alternatives + Land tabs.
 * Renders a single bypass corridor option with cost delta, risk badge,
 * and status label. Keyboard-focusable; fires onSelect on Enter/click.
 */

import type { BypassCorridorOption } from '@/generated/server/worldmonitor/supply_chain/v1/service_server';
import {
  formatCostDelta,
  warRiskTierLabel,
  warRiskTierClass,
  corridorStatusLabel,
  corridorStatusClass,
  escapeHtml,
} from '../tabs/route-utils';

export interface RouteCardOptions {
  option: BypassCorridorOption;
  index: number;
  isActive: boolean;
  onSelect: (option: BypassCorridorOption) => void;
}

export function renderRouteCard(opts: RouteCardOptions): HTMLDivElement {
  const { option: o, index, isActive, onSelect } = opts;
  const card = document.createElement('div');
  const statusCls = corridorStatusClass(o.status);
  const isDisabled = o.status === 'CORRIDOR_STATUS_UNAVAILABLE' || o.status === 'CORRIDOR_STATUS_PROPOSED';
  card.className = `re-route-card ${statusCls} ${isActive ? 're-route-card--active' : ''}`;
  card.setAttribute('role', 'option');
  card.setAttribute('aria-selected', isActive ? 'true' : 'false');
  card.setAttribute('tabindex', '0');
  card.dataset.idx = String(index);
  card.dataset.corridorId = o.id;

  if (isDisabled) {
    card.setAttribute('aria-disabled', 'true');
  }

  const statusTag = corridorStatusLabel(o.status);
  const riskCls = warRiskTierClass(o.warRiskTier);

  card.innerHTML = [
    `<div class="re-route-card__header">`,
    `  <span class="re-route-card__rank">${index + 1}</span>`,
    `  <span class="re-route-card__name">${escapeHtml(o.name)}</span>`,
    statusTag ? `  <span class="re-route-card__status">${escapeHtml(statusTag)}</span>` : '',
    `</div>`,
    `<div class="re-route-card__meta">`,
    `  <span class="re-route-card__delta">${formatCostDelta(o.addedTransitDays, o.addedCostMultiplier)}</span>`,
    `  <span class="re-route-card__risk ${riskCls}">${escapeHtml(warRiskTierLabel(o.warRiskTier))}</span>`,
    `</div>`,
  ].join('\n');

  if (!isDisabled) {
    const select = () => onSelect(o);
    card.addEventListener('click', select);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select();
      }
    });
  }

  return card;
}
