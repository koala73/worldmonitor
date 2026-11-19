import { t } from '@/services/i18n';
import type { ListPipelinesResponse } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';

/**
 * Banner text for a list-pipelines response, or '' when coverage is complete.
 *
 * The server sets upstreamUnavailable when either the gas or the oil registry
 * is missing. When rows of one commodity arrived and the other has none, the
 * other registry is the gap: name it. Anything else keeps the outage banner.
 */
export function pipelineCoverageWarning(
  data: Pick<ListPipelinesResponse, 'pipelines' | 'upstreamUnavailable'>,
): string {
  if (!data.upstreamUnavailable) return '';
  const rows = data.pipelines ?? [];
  const hasGas = rows.some((p) => p.commodityType === 'gas');
  const hasOil = rows.some((p) => p.commodityType === 'oil');
  // English first paint has only en.shell.json, so English needs defaultValue.
  if (hasGas && !hasOil) {
    return t('components.supplyChain.oilPipelinesUnavailable', { defaultValue: 'Oil pipeline data unavailable' });
  }
  if (hasOil && !hasGas) {
    return t('components.supplyChain.gasPipelinesUnavailable', { defaultValue: 'Gas pipeline data unavailable' });
  }
  return t('components.supplyChain.upstreamUnavailable');
}
