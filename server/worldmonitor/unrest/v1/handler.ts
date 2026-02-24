import type { UnrestServiceHandler } from '../../../../src/generated/server/worldmonitor/unrest/v1/service_server';

import { listUnrestEvents } from './list-unrest-events';

export const unrestHandler: UnrestServiceHandler = {
  listUnrestEvents,
};
