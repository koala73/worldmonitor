/**
 * Conflict service handler -- implements the generated ConflictServiceHandler
 * interface with 3 RPCs proxying three distinct upstream APIs:
 *   - listAcledEvents: ACLED API for battles, explosions, violence against civilians
 *   - listUcdpEvents: UCDP GED API with version discovery + paginated backward fetch
 *   - getHumanitarianSummary: HAPI/HDX API for humanitarian conflict event counts
 *
 * Consolidates four legacy data flows:
 *   - api/acled-conflict.js (ACLED conflict proxy)
 *   - api/ucdp-events.js (UCDP GED events proxy)
 *   - api/ucdp.js (UCDP classifications proxy)
 *   - api/hapi.js (HAPI humanitarian proxy)
 *
 * All RPCs have graceful degradation: return empty/default on upstream failure.
 * No error logging on upstream failures (following established 2F-01 pattern).
 */

import type { ConflictServiceHandler } from '../../../../src/generated/server/worldmonitor/conflict/v1/service_server';

import { listAcledEvents } from './list-acled-events';
import { listUcdpEvents } from './list-ucdp-events';
import { getHumanitarianSummary } from './get-humanitarian-summary';

export const conflictHandler: ConflictServiceHandler = {
  listAcledEvents,
  listUcdpEvents,
  getHumanitarianSummary,
};
