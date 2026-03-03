export const config = { runtime: 'edge' };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createDisplacementServiceRoutes } from '../../../src/generated/server/worldmonitor/displacement/v1/service_server';
import { displacementHandler } from '../../../server/worldmonitor/displacement/v1/handler';

export default createDomainGateway(
  createDisplacementServiceRoutes(displacementHandler, serverOptions),
);
