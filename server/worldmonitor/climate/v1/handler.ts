import type { ClimateServiceHandler } from '../../../../src/generated/server/worldmonitor/climate/v1/service_server';

import { listClimateAnomalies } from './list-climate-anomalies';
import { listClimateDisasters } from './list-climate-disasters';

export const climateHandler: ClimateServiceHandler = {
  listClimateAnomalies,
  listClimateDisasters,
};
