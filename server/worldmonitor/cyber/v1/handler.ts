import type { CyberServiceHandler } from '../../../../src/generated/server/worldmonitor/cyber/v1/service_server';

import { listCyberThreats } from './list-cyber-threats';
import { getNetworkInfo } from './get-network-info';

export const cyberHandler: CyberServiceHandler = {
  getNetworkInfo,
  listCyberThreats,
};
