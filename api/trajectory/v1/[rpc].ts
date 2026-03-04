export const config = { runtime: 'edge' };

import { checkKillswitch } from '../../../server/_shared/killswitch';
import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createTrajectoryServiceRoutes } from '../../../src/generated/server/worldmonitor/trajectory/v1/service_server';
import { trajectoryHandler } from '../../../server/worldmonitor/trajectory/v1/handler';

const disabled = checkKillswitch('TRAJECTORY');

export default disabled
  ? () => disabled
  : createDomainGateway(
      createTrajectoryServiceRoutes(trajectoryHandler, serverOptions),
    );
