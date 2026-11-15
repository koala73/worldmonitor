/**
 * Conflict service handler. These RPCs read cached seeds.
 * They do not call upstream APIs.
 */

import type { ConflictServiceHandler } from '../../../../src/generated/server/worldmonitor/conflict/v1/service_server';

import { listAcledEvents } from './list-acled-events';
import { listUcdpEvents } from './list-ucdp-events';
import { getHumanitarianSummary } from './get-humanitarian-summary';
import { getHumanitarianSummaryBatch } from './get-humanitarian-summary-batch';
import { listIranEvents } from './list-iran-events';

export const conflictHandler: ConflictServiceHandler = {
  listAcledEvents,
  listUcdpEvents,
  getHumanitarianSummary,
  getHumanitarianSummaryBatch,
  listIranEvents,
};
