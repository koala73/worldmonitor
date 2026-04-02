export const config = { runtime: 'edge', regions: ['iad1', 'lhr1', 'fra1', 'sfo1'] };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createIntelligenceServiceRoutes } from '../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { intelligenceHandler } from '../../../server/worldmonitor/intelligence/v1/handler';

export default createDomainGateway(
  createIntelligenceServiceRoutes(intelligenceHandler, serverOptions),
);
