export const config = { runtime: 'edge' };

import { checkKillswitch } from '../../../server/_shared/killswitch';
import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createSocialServiceRoutes } from '../../../src/generated/server/worldmonitor/social/v1/service_server';
import { socialHandler } from '../../../server/worldmonitor/social/v1/handler';

// SENTINEL: killswitch check for social module
const killswitchResponse = checkKillswitch('SOCIAL');

export default killswitchResponse
  ? () => killswitchResponse
  : createDomainGateway(
      createSocialServiceRoutes(socialHandler, serverOptions),
    );
