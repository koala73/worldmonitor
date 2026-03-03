export const config = { runtime: 'edge' };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createGivingServiceRoutes } from '../../../src/generated/server/worldmonitor/giving/v1/service_server';
import { givingHandler } from '../../../server/worldmonitor/giving/v1/handler';

export default createDomainGateway(
  createGivingServiceRoutes(givingHandler, serverOptions),
);
