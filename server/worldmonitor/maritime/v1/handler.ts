import type { MaritimeServiceHandler } from '../../../../src/generated/server/worldmonitor/maritime/v1/service_server';

import { getVesselSnapshot } from './get-vessel-snapshot';
import { listNavigationalWarnings } from './list-navigational-warnings';
import { listUkmtoIncidents } from './list-ukmto-incidents';

export const maritimeHandler: MaritimeServiceHandler = {
  listUkmtoIncidents,
  getVesselSnapshot,
  listNavigationalWarnings,
};
