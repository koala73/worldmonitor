import type { TrajectoryServiceHandler } from '../../../../src/generated/server/worldmonitor/trajectory/v1/service_server';

import { queryFlightHistory } from './flight-history';

export const trajectoryHandler: TrajectoryServiceHandler = {
  queryFlightHistory,
};
