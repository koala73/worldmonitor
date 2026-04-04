import type { ResilienceScoreResponse } from '@/services/resilience';

export type ResilienceVisualLevel = 'very_high' | 'high' | 'moderate' | 'low' | 'very_low' | 'unknown';

export const RESILIENCE_VISUAL_LEVEL_COLORS: Record<ResilienceVisualLevel, string> = {
  very_high: '#22c55e',
  high: '#84cc16',
  moderate: '#eab308',
  low: '#f97316',
  very_low: '#ef4444',
  unknown: 'var(--text-faint)',
};

const DOMAIN_LABELS: Record<string, string> = {
  economic: 'Economic',
  infrastructure: 'Infra & Supply',
  energy: 'Energy',
  'social-governance': 'Social & Gov',
  'health-food': 'Health & Food',
};

export function getResilienceVisualLevel(score: number): ResilienceVisualLevel {
  if (!Number.isFinite(score)) return 'unknown';
  if (score >= 80) return 'very_high';
  if (score >= 60) return 'high';
  if (score >= 40) return 'moderate';
  if (score >= 20) return 'low';
  return 'very_low';
}

export function getResilienceTrendArrow(trend: string): string {
  if (trend === 'rising') return '↑';
  if (trend === 'falling') return '↓';
  return '→';
}

export function getResilienceDomainLabel(domainId: string): string {
  return DOMAIN_LABELS[domainId] ?? domainId;
}

export function formatResilienceConfidence(data: ResilienceScoreResponse): string {
  if (data.lowConfidence) return 'Low confidence — sparse data';
  return `Confidence ${data.cronbachAlpha.toFixed(2)} ✓`;
}

export function formatResilienceChange30d(change30d: number): string {
  const rounded = Number.isFinite(change30d) ? change30d.toFixed(1) : '0.0';
  const sign = change30d > 0 ? '+' : '';
  return `30d ${sign}${rounded}`;
}
