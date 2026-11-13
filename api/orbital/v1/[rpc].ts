export const config = { runtime: 'edge' };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createOrbitalServiceRoutes } from '../../../src/generated/server/worldmonitor/orbital/v1/service_server';
import { orbitalHandler } from '../../../server/worldmonitor/orbital/v1/handler';

export default createDomainGateway(
  createOrbitalServiceRoutes(orbitalHandler, serverOptions),
);
