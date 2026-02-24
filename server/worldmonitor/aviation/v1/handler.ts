import type { AviationServiceHandler } from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';

import { listAirportDelays } from './list-airport-delays';

export const aviationHandler: AviationServiceHandler = {
  listAirportDelays,
};
