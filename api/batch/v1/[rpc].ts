export const config = { runtime: 'edge' };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createBatchServiceRoutes } from '../../../src/generated/server/worldmonitor/batch/v1/service_server';
import { batchHandler } from '../../../server/worldmonitor/batch/v1/handler';

export default createDomainGateway(
  createBatchServiceRoutes(batchHandler, serverOptions),
);
