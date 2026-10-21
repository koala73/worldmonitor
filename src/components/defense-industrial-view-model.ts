import type {
  DefenseIndustrialMetric,
  GetDefenseIndustrialBaseResponse,
} from '@/generated/client/worldmonitor/military/v1/service_client';

export function formatDefenseIndustrialMetric(
  metric: DefenseIndustrialMetric | undefined,
  suffix: string,
  integer = false,
  unavailableLabel = 'Not available',
): string {
  if (!metric?.available) return unavailableLabel;
  const value = integer
    ? Math.round(metric.value).toLocaleString()
    : metric.value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  let trend = '';
  if (metric.previousYear > 0 && Number.isFinite(metric.previousValue)) {
    const delta = metric.value - metric.previousValue;
    trend = delta > 0 ? ' ↑' : delta < 0 ? ' ↓' : ' →';
  }
  return `${value}${suffix} · ${metric.year}${trend}`;
}

export function defenseIndustrialSourceKey(
  data: GetDefenseIndustrialBaseResponse,
): 'countryBrief.defenseIndustrial.source' | 'countryBrief.defenseIndustrial.sourceWorldBank' {
  return data.suppliers.length > 0 && data.supplierSource
    ? 'countryBrief.defenseIndustrial.source'
    : 'countryBrief.defenseIndustrial.sourceWorldBank';
}
