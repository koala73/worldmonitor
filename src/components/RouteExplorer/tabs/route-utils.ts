/**
 * Pure formatting helpers for the Route Explorer tab panels.
 *
 * Kept in a sibling -utils file so node:test can import without pulling
 * @/services/i18n or DOM dependencies.
 */

import type {
  NumberRange,
  CorridorStatus,
} from '@/generated/server/worldmonitor/supply_chain/v1/service_server';

export function formatTransitRange(range: NumberRange | undefined): string {
  if (!range) return '\u2014';
  if (range.min === range.max) return `${range.min}d`;
  return `${range.min}\u2013${range.max}d`;
}

export function formatFreightRange(range: NumberRange | undefined, cargoType: string): string {
  if (!range) return '\u2014';
  const unit = cargoType === 'container' ? '/TEU' : '/ton';
  if (range.min === range.max) return `$${range.min.toLocaleString()}${unit}`;
  return `$${range.min.toLocaleString()}\u2013$${range.max.toLocaleString()}${unit}`;
}

export function formatCostDelta(addedTransitDays: number, addedCostMultiplier: number): string {
  const days = addedTransitDays > 0 ? `+${addedTransitDays}d` : '\u2014';
  const cost = addedCostMultiplier > 1 ? `+${Math.round((addedCostMultiplier - 1) * 100)}%` : '\u2014';
  return `${days} / ${cost}`;
}

export function formatExposurePct(pct: number): string {
  return `${Math.round(pct)}%`;
}

const WAR_RISK_LABELS: Record<string, string> = {
  WAR_RISK_TIER_UNSPECIFIED: 'Unknown',
  WAR_RISK_TIER_NORMAL: 'Normal',
  WAR_RISK_TIER_ELEVATED: 'Elevated',
  WAR_RISK_TIER_HIGH: 'High',
  WAR_RISK_TIER_CRITICAL: 'Critical',
  WAR_RISK_TIER_WAR_ZONE: 'War Zone',
};

export function warRiskTierLabel(tier: string): string {
  return WAR_RISK_LABELS[tier] ?? tier;
}

export function warRiskTierClass(tier: string): string {
  if (tier === 'WAR_RISK_TIER_WAR_ZONE' || tier === 'WAR_RISK_TIER_CRITICAL') return 're-risk--critical';
  if (tier === 'WAR_RISK_TIER_HIGH') return 're-risk--high';
  if (tier === 'WAR_RISK_TIER_ELEVATED') return 're-risk--elevated';
  return 're-risk--normal';
}

const CORRIDOR_STATUS_LABELS: Record<CorridorStatus, string> = {
  CORRIDOR_STATUS_UNSPECIFIED: '',
  CORRIDOR_STATUS_ACTIVE: '',
  CORRIDOR_STATUS_PROPOSED: '(proposed)',
  CORRIDOR_STATUS_UNAVAILABLE: '(unavailable)',
};

export function corridorStatusLabel(status: CorridorStatus): string {
  return CORRIDOR_STATUS_LABELS[status] ?? '';
}

export function corridorStatusClass(status: CorridorStatus): string {
  if (status === 'CORRIDOR_STATUS_PROPOSED') return 're-route-card--proposed';
  if (status === 'CORRIDOR_STATUS_UNAVAILABLE') return 're-route-card--unavailable';
  return '';
}

export function formatDisruptionScore(score: number): string {
  return `${Math.round(score)}/100`;
}

export function disruptionScoreClass(score: number): string {
  if (score >= 70) return 're-disruption--critical';
  if (score >= 40) return 're-disruption--high';
  return 're-disruption--normal';
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
