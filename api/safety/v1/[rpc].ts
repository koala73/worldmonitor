export const config = { runtime: 'edge' };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createSafetyServiceRoutes } from '../../../src/generated/server/worldmonitor/safety/v1/service_server';
import { safetyHandler } from '../../../server/worldmonitor/safety/v1/handler';

export default createDomainGateway(createSafetyServiceRoutes(safetyHandler, serverOptions));
