/**
 * GetPopulationExposure RPC: the priority-country population table, or an
 * exposure estimate for a point (country-average density x circle area). The
 * estimate is shared with the dashboard and the MCP tool.
 */

import type {
  ServerContext,
  GetPopulationExposureRequest,
  GetPopulationExposureResponse,
} from '../../../../src/generated/server/worldmonitor/displacement/v1/service_server';
import { listCountryPopulations } from '../../../../shared/analysis-population-exposure';
import { estimatePointExposure } from '../../../../shared/population-density-country-at';

export async function getPopulationExposure(
  _ctx: ServerContext,
  req: GetPopulationExposureRequest,
): Promise<GetPopulationExposureResponse> {
  if (req.mode === 'exposure') {
    const estimate = estimatePointExposure(req.lat, req.lon, req.radius || 50);
    if (!estimate) return { success: true, countries: [] };
    const { country, ...exposure } = estimate;
    return { success: true, countries: [], exposure: { ...exposure, nearestCountry: country } };
  }

  // Default: countries mode
  return { success: true, countries: listCountryPopulations() };
}
