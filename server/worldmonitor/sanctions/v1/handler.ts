import type { SanctionsServiceHandler } from '../../../../src/generated/server/worldmonitor/sanctions/v1/service_server';

import { listSanctionsPressure } from './list-sanctions-pressure';
import { lookupSanctionEntity } from './lookup-entity';

export const sanctionsHandler: SanctionsServiceHandler = {
  listSanctionsPressure,
  lookupSanctionEntity,
};
