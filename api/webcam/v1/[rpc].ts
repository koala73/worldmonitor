export const config = { runtime: 'edge' };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createWebcamServiceRoutes } from '../../../src/generated/server/worldmonitor/webcam/v1/service_server';
import { webcamHandler } from '../../../server/worldmonitor/webcam/v1/handler';

export default createDomainGateway(
  createWebcamServiceRoutes(webcamHandler, serverOptions),
);
