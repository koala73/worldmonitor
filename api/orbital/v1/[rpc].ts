export const config = { runtime: 'edge' };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createOrbitalServiceRoutes } from '../../../src/generated/server/worldmonitor/orbital/v1/service_server';
import { orbitalHandler } from '../../../server/worldmonitor/orbital/v1/handler';
import { isOrbitalWatchEnabled, orbitalWatchDarkResponse } from '../../../server/worldmonitor/orbital/v1/dark-launch';

const gateway = createDomainGateway(
  createOrbitalServiceRoutes(orbitalHandler, serverOptions),
);

export default function orbitalGateway(...args: Parameters<typeof gateway>): Promise<Response> {
  return isOrbitalWatchEnabled() ? gateway(...args) : Promise.resolve(orbitalWatchDarkResponse());
}
