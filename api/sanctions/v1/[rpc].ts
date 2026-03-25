export const config = { runtime: 'edge' };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createSanctionsServiceRoutes } from '../../../src/generated/server/worldmonitor/sanctions/v1/service_server';
import { sanctionsHandler } from '../../../server/worldmonitor/sanctions/v1/handler';

export default createDomainGateway(
  createSanctionsServiceRoutes(sanctionsHandler, serverOptions),
);
