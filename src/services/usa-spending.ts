import { getHydratedData } from '@/services/bootstrap';
import { toApiUrl } from '@/services/runtime';

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

interface RawSpending {
  awards?: GovernmentAward[];
  totalAmount?: number;
  periodStart?: string;
  periodEnd?: string;
  fetchedAt?: number;
}

function toSummary(raw: RawSpending): SpendingSummary {
  return {
    awards: raw.awards!,
    totalAmount: raw.totalAmount ?? raw.awards!.reduce((s, a) => s + a.amount, 0),
    periodStart: raw.periodStart ?? '',
    periodEnd: raw.periodEnd ?? '',
    fetchedAt: raw.fetchedAt ? new Date(raw.fetchedAt) : new Date(),
  };
}

const EMPTY_SUMMARY: SpendingSummary = { awards: [], totalAmount: 0, periodStart: '', periodEnd: '', fetchedAt: new Date() };

export async function fetchRecentAwards(): Promise<SpendingSummary> {
  const hydrated = getHydratedData('spending') as RawSpending | undefined;
  if (hydrated?.awards?.length) return toSummary(hydrated);

  try {
    const resp = await fetch(toApiUrl('/api/bootstrap?keys=spending'), { signal: AbortSignal.timeout(8000) });
    if (resp.ok) {
      const json = await resp.json() as { data?: { spending?: RawSpending } };
      const raw = json.data?.spending;
      if (raw?.awards?.length) return toSummary(raw);
    }
  } catch { /* fall through to empty */ }

  return EMPTY_SUMMARY;
}

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

export function getAwardTypeIcon(type: GovernmentAward['awardType']): string {
  switch (type) {
    case 'contract': return '📄';
    case 'grant': return '🎁';
    case 'loan': return '💰';
    default: return '📋';
  }
}
