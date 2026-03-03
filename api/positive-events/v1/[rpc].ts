export const config = { runtime: 'edge' };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createPositiveEventsServiceRoutes } from '../../../src/generated/server/worldmonitor/positive_events/v1/service_server';
import { positiveEventsHandler } from '../../../server/worldmonitor/positive-events/v1/handler';

export default createDomainGateway(
  createPositiveEventsServiceRoutes(positiveEventsHandler, serverOptions),
);
