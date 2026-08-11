import {
  DEFAULT_CHINA_FACTORY_CLUSTER_ID,
  chinaFactoryClusterById,
} from '../../../shared/china-factory-clusters';

export const CHINA_FACTORY_PATH = '/china-factory';

export type ChinaFactoryFilters = Readonly<{
  clusterId: string;
  period: string;
  hs2: string;
}>;

export const DEFAULT_CHINA_FACTORY_FILTERS: ChinaFactoryFilters = Object.freeze({
  clusterId: DEFAULT_CHINA_FACTORY_CLUSTER_ID,
  period: '2024',
  hs2: '64',
});

export type ChinaFactoryTradeRecord = Readonly<{
  reporterCode: string;
  partnerCode: string;
  partnerName: string;
  cmdCode: string;
  cmdDesc: string;
  year: number;
  tradeValueUsd: number;
  netWeightKg: number;
}>;

export function isChinaFactoryPath(pathname: string): boolean {
  return /^\/china-factory\/?$/.test(pathname);
}

export function normalizeChinaFactoryPeriod(raw: string | null | undefined): string {
  const value = String(raw ?? '').trim();
  return /^20\d{2}$/.test(value) ? value : DEFAULT_CHINA_FACTORY_FILTERS.period;
}

export function normalizeChinaFactoryHs2(raw: string | null | undefined): string {
  const value = String(raw ?? '').trim();
  return /^\d{2}$/.test(value) ? value : DEFAULT_CHINA_FACTORY_FILTERS.hs2;
}

export function chinaFactoryFiltersFromSearch(search: string): ChinaFactoryFilters {
  const params = new URLSearchParams(search);
  const cluster = chinaFactoryClusterById(params.get('cluster'));
  const hs2 = normalizeChinaFactoryHs2(params.get('hs2'));
  return {
    clusterId: cluster.id,
    period: normalizeChinaFactoryPeriod(params.get('period')),
    hs2,
  };
}

export function chinaFactoryUrl(filters: Partial<ChinaFactoryFilters> = {}): string {
  const normalized: ChinaFactoryFilters = {
    clusterId: chinaFactoryClusterById(filters.clusterId ?? DEFAULT_CHINA_FACTORY_FILTERS.clusterId).id,
    period: normalizeChinaFactoryPeriod(filters.period ?? DEFAULT_CHINA_FACTORY_FILTERS.period),
    hs2: normalizeChinaFactoryHs2(filters.hs2 ?? DEFAULT_CHINA_FACTORY_FILTERS.hs2),
  };
  const query = new URLSearchParams({
    cluster: normalized.clusterId,
    period: normalized.period,
    hs2: normalized.hs2,
  });
  return `${CHINA_FACTORY_PATH}?${query.toString()}`;
}

/**
 * The same period and HS2 filter is applied to every value-bearing panel.
 * Records describe China-level reporter data only, never a chosen town's
 * shipment or loading port.
 */
export function selectObservedChinaFactoryTrade(
  records: readonly ChinaFactoryTradeRecord[] | undefined,
  filters: ChinaFactoryFilters,
): ChinaFactoryTradeRecord[] {
  const year = Number(filters.period);
  return (records ?? [])
    .filter((record) => record.reporterCode === '156')
    .filter((record) => record.year === year)
    .filter((record) => record.cmdCode.startsWith(filters.hs2))
    .filter((record) => Number.isFinite(record.tradeValueUsd) && record.tradeValueUsd >= 0)
    .sort((left, right) => right.tradeValueUsd - left.tradeValueUsd || left.partnerCode.localeCompare(right.partnerCode));
}
