export const config = { runtime: 'edge' };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createIntelligenceServiceRoutes } from '../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { intelligenceHandler } from '../../../server/worldmonitor/intelligence/v1/handler';

export default createDomainGateway(
  createIntelligenceServiceRoutes(intelligenceHandler, serverOptions),
);
