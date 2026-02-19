import type { PizzIntStatus, PizzIntLocation, PizzIntDefconLevel, GdeltTensionPair } from '@/types';
import { createCircuitBreaker, fetchWithCache } from '@/utils';
import { t } from '@/services/i18n';

interface PizzIntApiResponse {
  success: boolean;
  data: Array<{
    place_id: string;
    name: string;
    address: string;
    current_popularity: number;
    percentage_of_usual: number | null;
    is_spike: boolean;
    spike_magnitude: number | null;
    data_source: string;
    recorded_at: string;
    data_freshness: 'fresh' | 'stale';
    is_closed_now?: boolean;
  }>;
}

interface GdeltApiResponse {
  [key: string]: Array<{ t: number; v: number }>;
}

const pizzintBreaker = createCircuitBreaker<PizzIntStatus>({
  name: 'PizzINT',
  maxFailures: 3,
  cooldownMs: 5 * 60 * 1000,
  cacheTtlMs: 2 * 60 * 1000
});

const gdeltBreaker = createCircuitBreaker<GdeltTensionPair[]>({
  name: 'GDELT Tensions',
  maxFailures: 3,
  cooldownMs: 5 * 60 * 1000,
  cacheTtlMs: 10 * 60 * 1000
});

const DEFCON_THRESHOLDS: Array<{ level: PizzIntDefconLevel; min: number; labelKey: string }> = [
  { level: 1, min: 85, labelKey: 'components.pizzint.defconLabels.1' },
  { level: 2, min: 70, labelKey: 'components.pizzint.defconLabels.2' },
  { level: 3, min: 50, labelKey: 'components.pizzint.defconLabels.3' },
  { level: 4, min: 25, labelKey: 'components.pizzint.defconLabels.4' },
  { level: 5, min: 0, labelKey: 'components.pizzint.defconLabels.5' },
];

function calculateDefcon(aggregateActivity: number, activeSpikes: number): { level: PizzIntDefconLevel; label: string } {
  let adjusted = aggregateActivity;
  if (activeSpikes > 0) adjusted += activeSpikes * 10;
  adjusted = Math.min(100, adjusted);

  for (const threshold of DEFCON_THRESHOLDS) {
    if (adjusted >= threshold.min) {
      return { level: threshold.level, label: t(threshold.labelKey) };
    }
  }
  return { level: 5, label: t('components.pizzint.defconLabels.5') };
}

function extractCoordinates(address: string): { lat?: number; lng?: number } {
  const match = address.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (match && match[1] && match[2]) {
    return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
  }
  return {};
}

const defaultStatus: PizzIntStatus = {
  defconLevel: 5,
  defconLabel: t('components.pizzint.defconLabels.5'),
  aggregateActivity: 0,
  activeSpikes: 0,
  locationsMonitored: 0,
  locationsOpen: 0,
  lastUpdate: new Date(),
  dataFreshness: 'stale',
  locations: []
};

export async function fetchPizzIntStatus(): Promise<PizzIntStatus> {
  return pizzintBreaker.execute(async () => {
    const data = await fetchWithCache<PizzIntApiResponse>('/api/pizzint/dashboard-data', { ttl: 60_000 });
    if (!data.success || !data.data) throw new Error('Invalid response');

    const locations: PizzIntLocation[] = data.data.map(loc => ({
      ...loc,
      is_closed_now: loc.is_closed_now ?? false,
      ...extractCoordinates(loc.address)
    }));

    const openLocations = locations.filter(l => !l.is_closed_now);

    // Use percentage_of_usual (comparison to baseline) as primary metric
    // This matches PizzINT's calculation which compares current to expected activity
    // Cap at 100 since values can exceed 100% (e.g., 200% = 2x normal)
    const locationsWithUsual = locations.filter(l => l.percentage_of_usual !== null && l.percentage_of_usual > 0);
    const aggregateActivity = locationsWithUsual.length > 0
      ? Math.round(locationsWithUsual.reduce((sum, l) => sum + Math.min(l.percentage_of_usual ?? 0, 100), 0) / locationsWithUsual.length)
      : openLocations.length > 0
        ? Math.round(openLocations.reduce((sum, l) => sum + l.current_popularity, 0) / openLocations.length)
        : 0;

    const activeSpikes = locations.filter(l => l.is_spike).length;
    const freshness = locations.some(l => l.data_freshness === 'fresh') ? 'fresh' : 'stale';

    const { level, label } = calculateDefcon(aggregateActivity, activeSpikes);

    const latestUpdate = locations.reduce((latest, loc) => {
      const locDate = new Date(loc.recorded_at);
      return locDate > latest ? locDate : latest;
    }, new Date(0));

    return {
      defconLevel: level,
      defconLabel: label,
      aggregateActivity,
      activeSpikes,
      locationsMonitored: locations.length,
      locationsOpen: openLocations.length,
      lastUpdate: latestUpdate,
      dataFreshness: freshness,
      locations
    };
  }, defaultStatus);
}

const TENSION_PAIRS = [
  { id: 'usa_russia', countries: ['USA', 'Russia'] as [string, string], label: 'USA ↔ Russia', region: 'europe' },
  { id: 'russia_ukraine', countries: ['Russia', 'Ukraine'] as [string, string], label: 'Russia ↔ Ukraine', region: 'europe' },
  { id: 'usa_china', countries: ['USA', 'China'] as [string, string], label: 'USA ↔ China', region: 'asia' },
  { id: 'china_taiwan', countries: ['China', 'Taiwan'] as [string, string], label: 'China ↔ Taiwan', region: 'asia' },
  { id: 'usa_iran', countries: ['USA', 'Iran'] as [string, string], label: 'USA ↔ Iran', region: 'middle_east' },
  { id: 'usa_venezuela', countries: ['USA', 'Venezuela'] as [string, string], label: 'USA ↔ Venezuela', region: 'americas' },
];

export async function fetchGdeltTensions(): Promise<GdeltTensionPair[]> {
  return gdeltBreaker.execute(async () => {
    const pairs = TENSION_PAIRS.map(p => p.id).join(',');
    const endDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '');

    const data = await fetchWithCache<GdeltApiResponse>(
      `/api/pizzint/gdelt/batch?pairs=${pairs}&method=gpr&dateStart=${startDate}&dateEnd=${endDate}`,
      { ttl: 300_000 },
    );

    return TENSION_PAIRS.map(pair => {
      const pairData = data[pair.id] || [];
      const recent = pairData.slice(-7);
      const older = pairData.slice(-14, -7);

      const recentAvg = recent.length > 0 ? recent.reduce((s, d) => s + d.v, 0) / recent.length : 0;
      const olderAvg = older.length > 0 ? older.reduce((s, d) => s + d.v, 0) / older.length : recentAvg;

      const changePercent = olderAvg > 0 ? ((recentAvg - olderAvg) / olderAvg) * 100 : 0;
      const trend = changePercent > 5 ? 'rising' : changePercent < -5 ? 'falling' : 'stable';

      return {
        id: pair.id,
        countries: pair.countries,
        label: pair.label,
        score: Math.round(recentAvg * 100) / 100,
        trend,
        changePercent: Math.round(changePercent * 10) / 10,
        region: pair.region
      };
    });
  }, []);
}

export function getPizzIntStatus(): string {
  return pizzintBreaker.getStatus();
}

export function getGdeltStatus(): string {
  return gdeltBreaker.getStatus();
}
