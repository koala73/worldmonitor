export const config = { runtime: 'edge' };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createEconomicServiceRoutes } from '../../../src/generated/server/worldmonitor/economic/v1/service_server';
import { economicHandler } from '../../../server/worldmonitor/economic/v1/handler';

export default createDomainGateway(
  createEconomicServiceRoutes(economicHandler, serverOptions),
);
