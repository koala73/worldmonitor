/**
 * USASpending.gov API Service
 * Tracks federal government contracts and awards
 * Free API - no key required
 */

import { dataFreshness } from './data-freshness';

export interface GovernmentAward {
  id: string;
  recipientName: string;
  amount: number;
  agency: string;
  description: string;
  startDate: string;
  awardType: 'contract' | 'grant' | 'loan' | 'other';
}

export interface SpendingSummary {
  awards: GovernmentAward[];
  totalAmount: number;
  periodStart: string;
  periodEnd: string;
  fetchedAt: Date;
}

const API_BASE = 'https://api.usaspending.gov/api/v2';

// Award type code mapping
const AWARD_TYPE_MAP: Record<string, GovernmentAward['awardType']> = {
  'A': 'contract', 'B': 'contract', 'C': 'contract', 'D': 'contract',
  '02': 'grant', '03': 'grant', '04': 'grant', '05': 'grant',
  '06': 'grant', '10': 'grant',
  '07': 'loan', '08': 'loan',
};

function getDateDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().split('T')[0]!;
}

function getToday(): string {
  return new Date().toISOString().split('T')[0]!;
}

// Input validation bounds
const MAX_DAYS_BACK = 90;
const MIN_DAYS_BACK = 1;
const MAX_LIMIT = 50;
const MIN_LIMIT = 1;

function validateDaysBack(val: number): number {
  return Math.max(MIN_DAYS_BACK, Math.min(MAX_DAYS_BACK, Math.floor(val)));
}

function validateLimit(val: number): number {
  return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.floor(val)));
}

/**
 * Fetch recent government awards/contracts
 */
export async function fetchRecentAwards(options: {
  daysBack?: number;
  limit?: number;
  awardTypes?: ('contract' | 'grant' | 'loan')[];
} = {}): Promise<SpendingSummary> {
  const daysBack = validateDaysBack(options.daysBack ?? 7);
  const limit = validateLimit(options.limit ?? 15);
  const awardTypes = options.awardTypes ?? ['contract'];

  const periodStart = getDateDaysAgo(daysBack);
  const periodEnd = getToday();

  // Map award types to codes
  const awardTypeCodes: string[] = [];
  if (awardTypes.includes('contract')) awardTypeCodes.push('A', 'B', 'C', 'D');
  if (awardTypes.includes('grant')) awardTypeCodes.push('02', '03', '04', '05', '06', '10');
  if (awardTypes.includes('loan')) awardTypeCodes.push('07', '08');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${API_BASE}/search/spending_by_award/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        filters: {
          time_period: [{ start_date: periodStart, end_date: periodEnd }],
          award_type_codes: awardTypeCodes,
        },
        fields: [
          'Award ID',
          'Recipient Name',
          'Award Amount',
          'Awarding Agency',
          'Description',
          'Start Date',
          'Award Type',
        ],
        limit,
        order: 'desc',
        sort: 'Award Amount',
      }),
    });

    if (!response.ok) {
      throw new Error(`USASpending API error: ${response.status}`);
    }

    const data = await response.json();
    const results = data.results || [];

    const awards: GovernmentAward[] = results.map((r: Record<string, unknown>) => ({
      id: String(r['Award ID'] || ''),
      recipientName: String(r['Recipient Name'] || 'Unknown'),
      amount: Number(r['Award Amount']) || 0,
      agency: String(r['Awarding Agency'] || 'Unknown'),
      description: String(r['Description'] || '').slice(0, 200),
      startDate: String(r['Start Date'] || ''),
      awardType: AWARD_TYPE_MAP[String(r['Award Type'] || '')] || 'other',
    }));

    const totalAmount = awards.reduce((sum, a) => sum + a.amount, 0);

    // Record data freshness
    if (awards.length > 0) {
      dataFreshness.recordUpdate('spending', awards.length);
    }

    return {
      awards,
      totalAmount,
      periodStart,
      periodEnd,
      fetchedAt: new Date(),
    };
  } catch (error) {
    console.error('[USASpending] Fetch failed:', error);
    dataFreshness.recordError('spending', error instanceof Error ? error.message : 'Unknown error');
    return {
      awards: [],
      totalAmount: 0,
      periodStart,
      periodEnd,
      fetchedAt: new Date(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Format currency for display
 */
export function formatAwardAmount(amount: number): string {
  if (amount >= 1_000_000_000) {
    return `$${(amount / 1_000_000_000).toFixed(1)}B`;
  }
  if (amount >= 1_000_000) {
    return `$${(amount / 1_000_000).toFixed(1)}M`;
  }
  if (amount >= 1_000) {
    return `$${(amount / 1_000).toFixed(0)}K`;
  }
  return `$${amount.toFixed(0)}`;
}

/**
 * Get award type emoji
 */
export function getAwardTypeIcon(type: GovernmentAward['awardType']): string {
  switch (type) {
    case 'contract': return '📄';
    case 'grant': return '🎁';
    case 'loan': return '💰';
    default: return '📋';
  }
}
