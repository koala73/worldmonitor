import type { MaritimeServiceHandler } from '../../../../src/generated/server/worldmonitor/maritime/v1/service_server';

import { getVesselSnapshot } from './get-vessel-snapshot';
import { listNavigationalWarnings } from './list-navigational-warnings';

export const maritimeHandler: MaritimeServiceHandler = {
  getVesselSnapshot,
  listNavigationalWarnings,
};
