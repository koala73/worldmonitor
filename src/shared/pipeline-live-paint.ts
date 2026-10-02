import type { ListPipelinesResponse } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';

/**
 * Live RPC paint gate for listPipelines. Partial registry misses set
 * upstreamUnavailable while retaining rows — keep the map when any rows
 * arrived. showError is only for empty + unavailable. A healthy empty
 * registry still paints so valid empty data is not treated as an outage.
 */
export function shouldErrorOnPipelineLiveResponse(
  live: Pick<ListPipelinesResponse, 'pipelines' | 'upstreamUnavailable'>,
): boolean {
  return Boolean(live.upstreamUnavailable && !(live.pipelines?.length > 0));
}
