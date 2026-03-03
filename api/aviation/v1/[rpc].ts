export const config = { runtime: 'edge' };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createAviationServiceRoutes } from '../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { aviationHandler } from '../../../server/worldmonitor/aviation/v1/handler';

export default createDomainGateway(
  createAviationServiceRoutes(aviationHandler, serverOptions),
);
