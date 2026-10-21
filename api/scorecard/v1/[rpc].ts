export const config = { runtime: 'edge' };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { scorecardHandler } from '../../../server/worldmonitor/scorecard/v1/handler';
import { createScorecardServiceRoutes } from '../../../src/generated/server/worldmonitor/scorecard/v1/service_server';

export default createDomainGateway(
  createScorecardServiceRoutes(scorecardHandler, serverOptions),
);
