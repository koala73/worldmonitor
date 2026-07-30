import type { BatchServiceHandler } from '../../../../src/generated/server/worldmonitor/batch/v1/service_server';

import { executeBatch } from './execute-batch';

export const batchHandler: BatchServiceHandler = {
  executeBatch,
};
