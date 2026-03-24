export const config = { runtime: 'edge' };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createReitsServiceRoutes } from '../../../src/generated/server/worldmonitor/reits/v1/service_server';
import { reitsHandler } from '../../../server/worldmonitor/reits/v1/handler';

export default createDomainGateway(
  createReitsServiceRoutes(reitsHandler, serverOptions),
);
