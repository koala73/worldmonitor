export const config = { runtime: 'edge' };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createCyberServiceRoutes } from '../../../src/generated/server/worldmonitor/cyber/v1/service_server';
import { cyberHandler } from '../../../server/worldmonitor/cyber/v1/handler';

export default createDomainGateway(
  createCyberServiceRoutes(cyberHandler, serverOptions),
);
