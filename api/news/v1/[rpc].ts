export const config = { runtime: 'edge', regions: ['iad1', 'lhr1', 'fra1', 'sfo1'] };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createNewsServiceRoutes } from '../../../src/generated/server/worldmonitor/news/v1/service_server';
import { newsHandler } from '../../../server/worldmonitor/news/v1/handler';

export default createDomainGateway(
  createNewsServiceRoutes(newsHandler, serverOptions),
);
