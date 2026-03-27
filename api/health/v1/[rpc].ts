export const config = { runtime: 'edge' };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createHealthServiceRoutes } from '../../../src/generated/server/worldmonitor/health/v1/service_server';
import { healthHandler } from '../../../server/worldmonitor/health/v1/handler';

export default createDomainGateway(
  createHealthServiceRoutes(healthHandler, serverOptions),
);
