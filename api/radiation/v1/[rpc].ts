export const config = { runtime: 'edge' };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createRadiationServiceRoutes } from '../../../src/generated/server/worldmonitor/radiation/v1/service_server';
import { radiationHandler } from '../../../server/worldmonitor/radiation/v1/handler';

export default createDomainGateway(
  createRadiationServiceRoutes(radiationHandler, serverOptions),
);
