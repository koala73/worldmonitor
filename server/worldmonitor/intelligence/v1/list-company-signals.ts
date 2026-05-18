/**
 * RPC: listCompanySignals — disabled.
 *
 * Previously emitted typed "company signals" derived from guessed identity
 * mappings and keyword co-occurrence in third-party discussion threads. The
 * upstream sources verified neither ownership nor authorship, so outputs were
 * structurally indistinguishable from fabricated intelligence. See issues
 * #3754 and #3755 (koala73/worldmonitor) for the full diagnosis.
 *
 * The route is preserved (proto contract, OpenAPI op, gateway entry) so
 * existing callers keep working. The handler now returns an empty envelope.
 * Re-enable only behind a verified attribution model (maintained company-to-
 * code-host registry plus an authoritative jobs / funding source), never with
 * another keyword or slug heuristic.
 */

import type {
  ServerContext,
  ListCompanySignalsRequest,
  ListCompanySignalsResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

export async function listCompanySignals(
  _ctx: ServerContext,
  req: ListCompanySignalsRequest,
): Promise<ListCompanySignalsResponse> {
  const company = req.company?.trim();
  const domain = req.domain?.trim().toLowerCase();

  if (!company) {
    throw new ValidationError([{ field: 'company', description: 'company is required' }]);
  }

  return {
    company,
    domain: domain || '',
    signals: [],
    summary: {
      totalSignals: 0,
      byType: {},
      strongestSignal: undefined,
      signalDiversity: 0,
    },
    discoveredAtMs: Date.now(),
  };
}
