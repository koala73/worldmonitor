import type { HealthServiceHandler } from '../../../../src/generated/server/worldmonitor/health/v1/service_server';

import { listDiseaseOutbreaks } from './list-disease-outbreaks';

export const healthHandler: HealthServiceHandler = {
  listDiseaseOutbreaks,
};
