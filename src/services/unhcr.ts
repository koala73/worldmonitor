import { createCircuitBreaker, getCSSColor } from '@/utils';
import type { UnhcrSummary, CountryDisplacement } from '@/types';

interface UnhcrApiResponse extends UnhcrSummary {
  success: boolean;
  cached_at?: string;
}

export interface UnhcrFetchResult {
  ok: boolean;
  data: UnhcrSummary;
  cachedAt?: string;
}

const breaker = createCircuitBreaker<UnhcrApiResponse>({ name: 'UNHCR Displacement' });

const emptyResult: UnhcrSummary = {
  year: new Date().getFullYear(),
  globalTotals: { refugees: 0, asylumSeekers: 0, idps: 0, stateless: 0, total: 0 },
  countries: [],
  topFlows: [],
};

export async function fetchUnhcrPopulation(): Promise<UnhcrFetchResult> {
  const result = await breaker.execute(async () => {
    const response = await fetch('/api/unhcr-population', {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data.success) throw new Error('UNHCR API returned failure');
    return data as UnhcrApiResponse;
  }, { success: false, ...emptyResult });

  const { success, cached_at, ...summary } = result;
  return {
    ok: success === true,
    data: success === true ? summary : emptyResult,
    cachedAt: cached_at,
  };
}

export function getDisplacementColor(totalDisplaced: number): [number, number, number, number] {
  if (totalDisplaced >= 1_000_000) return [255, 50, 50, 200];
  if (totalDisplaced >= 500_000) return [255, 150, 0, 200];
  if (totalDisplaced >= 100_000) return [255, 220, 0, 180];
  return [100, 200, 100, 150];
}

export function getDisplacementBadge(totalDisplaced: number): { label: string; color: string } {
  if (totalDisplaced >= 1_000_000) return { label: 'CRISIS', color: getCSSColor('--semantic-critical') };
  if (totalDisplaced >= 500_000) return { label: 'HIGH', color: getCSSColor('--semantic-high') };
  if (totalDisplaced >= 100_000) return { label: 'ELEVATED', color: getCSSColor('--semantic-elevated') };
  return { label: '', color: '' };
}

export function formatPopulation(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export function getOriginCountries(data: UnhcrSummary): CountryDisplacement[] {
  return [...data.countries]
    .filter(c => c.refugees + c.asylumSeekers > 0)
    .sort((a, b) => (b.refugees + b.asylumSeekers) - (a.refugees + a.asylumSeekers));
}

export function getHostCountries(data: UnhcrSummary): CountryDisplacement[] {
  return [...data.countries]
    .filter(c => (c.hostTotal || 0) > 0)
    .sort((a, b) => (b.hostTotal || 0) - (a.hostTotal || 0));
}
