import type {
  ClimateServiceHandler,
  ServerContext,
  GetCo2MonitoringRequest,
  GetCo2MonitoringResponse,
} from '../../../../src/generated/server/worldmonitor/climate/v1/service_server';

import { CLIMATE_CO2_MONITORING_KEY } from '../../../_shared/cache-keys';
import { getCachedJson } from '../../../_shared/redis';

export const getCo2Monitoring: ClimateServiceHandler['getCo2Monitoring'] = async (
  _ctx: ServerContext,
  _req: GetCo2MonitoringRequest,
): Promise<GetCo2MonitoringResponse> => {
  try {
    const cached = await getCachedJson(CLIMATE_CO2_MONITORING_KEY, true);
    return (cached as GetCo2MonitoringResponse | null) ?? {};
  } catch {
    return {};
  }
};
