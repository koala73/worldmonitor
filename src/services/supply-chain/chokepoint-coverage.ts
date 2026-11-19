import { t } from '@/services/i18n';
import type { GetChokepointStatusResponse } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';

/**
 * Banner text for a chokepoint-status response, or '' when coverage is complete.
 *
 * The server sets upstreamUnavailable for any gap, including one chokepoint
 * missing transit data while the rest are current. Navigation warnings and the
 * AIS snapshot are global sources, so a per-row transit gap with both of them up
 * is partial coverage: name the affected chokepoints. Anything else keeps the
 * outage banner.
 */
export function chokepointCoverageWarning(
  data: Pick<GetChokepointStatusResponse, 'chokepoints' | 'upstreamUnavailable'>,
): string {
  if (!data.upstreamUnavailable) return '';
  const rows = data.chokepoints ?? [];
  const sharedSourcesUp = rows.every((cp) => cp.navigationalWarningsAvailable === true && cp.aisSnapshotAvailable === true);
  const missing = rows.filter((cp) => cp.transitSummary?.dataAvailable !== true);
  if (sharedSourcesUp && missing.length > 0 && missing.length < rows.length) {
    // English first paint has only en.shell.json, and the raw-key healer cannot
    // restore the names into an interpolated string.
    return t('components.supplyChain.partialTransitCoverage', {
      names: missing.map((cp) => cp.name).join(', '),
      defaultValue: '{{names}} transit data unavailable',
    });
  }
  return t('components.supplyChain.upstreamUnavailable');
}
