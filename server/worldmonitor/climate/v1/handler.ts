import type { ClimateServiceHandler } from '../../../../src/generated/server/worldmonitor/climate/v1/service_server';

import { getCo2Monitoring } from './get-co2-monitoring';
import { getOceanIceData } from './get-ocean-ice-data';
import { listAirQualityData } from './list-air-quality-data';
import { listClimateAnomalies } from './list-climate-anomalies';
import { listClimateDisasters } from './list-climate-disasters';
import { listClimateNews } from './list-climate-news';
import { listReservoirLevels } from './list-reservoir-levels';

export const climateHandler: ClimateServiceHandler = {
  getCo2Monitoring,
  getOceanIceData,
  listAirQualityData,
  listClimateAnomalies,
  listClimateDisasters,
  listClimateNews,
  listReservoirLevels,
};
