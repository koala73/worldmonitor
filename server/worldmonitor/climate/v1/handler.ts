import type { ClimateServiceHandler } from '../../../../src/generated/server/worldmonitor/climate/v1/service_server';

import { getCo2Monitoring } from './get-co2-monitoring';
import { listAirQualityData } from './list-air-quality-data';
import { listClimateAnomalies } from './list-climate-anomalies';
import { listClimateNews } from './list-climate-news';

export const climateHandler: ClimateServiceHandler = {
  getCo2Monitoring,
  listAirQualityData,
  listClimateAnomalies,
  listClimateNews,
};
