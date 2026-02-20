import type { InfrastructureServiceHandler } from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';

import { listInternetOutages } from './list-internet-outages';
import { listServiceStatuses } from './list-service-statuses';
import { getTemporalBaseline } from './get-temporal-baseline';
import { recordBaselineSnapshot } from './record-baseline-snapshot';

export const infrastructureHandler: InfrastructureServiceHandler = {
  listInternetOutages,
  listServiceStatuses,
  getTemporalBaseline,
  recordBaselineSnapshot,
};
