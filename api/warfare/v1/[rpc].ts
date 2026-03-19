export const config = { runtime: 'edge' };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createWarfareServiceRoutes } from '../../../src/generated/server/worldmonitor/warfare/v1/service_server';
import { warfareHandler } from '../../../server/worldmonitor/warfare/v1/handler';

export default createDomainGateway(
  createWarfareServiceRoutes(warfareHandler, serverOptions),
);
