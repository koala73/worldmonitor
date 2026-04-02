// Stub: breaking-news-alerts removed in REITs-only variant

import type { NewsItem } from '@/types';

export interface BreakingAlert {
  id: string;
  headline: string;
  title: string;
  source: string;
  link: string;
  threatLevel: 'critical' | 'high';
  level: 'critical' | 'high';
  category: string;
  timestamp: number;
  origin?: string;
}

export interface AlertSettings {
  enabled: boolean;
  soundEnabled: boolean;
  minLevel: 'critical' | 'high';
}

export function getAlertSettings(): AlertSettings {
  return { enabled: false, soundEnabled: false, minLevel: 'critical' };
}

export function checkBatchForBreakingAlerts(_items: NewsItem[]): void {
  // no-op in REITs-only mode
}

export function initBreakingNewsAlerts(): void {
  // no-op
}

export function destroyBreakingNewsAlerts(): void {
  // no-op
}
