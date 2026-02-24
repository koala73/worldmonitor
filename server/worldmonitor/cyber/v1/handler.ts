import type { CyberServiceHandler } from '../../../../src/generated/server/worldmonitor/cyber/v1/service_server';

import { listCyberThreats } from './list-cyber-threats';

export const cyberHandler: CyberServiceHandler = {
  listCyberThreats,
};
