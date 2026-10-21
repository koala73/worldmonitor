/**
 * GetPopulationExposure RPC -- provides population data for priority countries
 * and computes population exposure estimates within a given radius of a
 * geographic point using population density approximations.
 *
 * Computation core is shared with the dashboard via
 * shared/analysis-population-exposure.ts (issue #5696).
 */

import type {
  ServerContext,
  GetPopulationExposureRequest,
  GetPopulationExposureResponse,
} from '../../../../src/generated/server/worldmonitor/displacement/v1/service_server';
import {
  computeExposure,
  listCountryPopulations,
} from '../../../../shared/analysis-population-exposure';

export async function getPopulationExposure(
  _ctx: ServerContext,
  req: GetPopulationExposureRequest,
): Promise<GetPopulationExposureResponse> {
  if (req.mode === 'exposure') {
    const radius = req.radius || 50;
    const exposure = computeExposure(req.lat, req.lon, radius);

    return {
      success: true,
      countries: [],
      exposure,
    };
  }

  // Default: countries mode
  return { success: true, countries: listCountryPopulations() };
}
