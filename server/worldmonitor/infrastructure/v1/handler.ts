import type { InfrastructureServiceHandler } from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';

import { getCableHealth } from './get-cable-health';
import { listInternetOutages } from './list-internet-outages';
import { listServiceStatuses } from './list-service-statuses';
import { getTemporalBaseline } from './get-temporal-baseline';
import { recordBaselineSnapshot } from './record-baseline-snapshot';

export const infrastructureHandler: InfrastructureServiceHandler = {
  getCableHealth,
  listInternetOutages,
  listServiceStatuses,
  getTemporalBaseline,
  recordBaselineSnapshot,
};
