/**
 * RPC: getCompanyEnrichment — disabled.
 *
 * Previously aggregated "company enrichment" by guessing a code-host org from
 * the requested domain and decorating the response with whatever public data
 * that guessed identity returned (org metadata, language mix, public-filings
 * search, third-party discussion mentions). No ownership verification, no
 * filer-CIK match — any domain whose label collapsed to an unrelated org slug
 * was attributed someone else's footprint. Same anti-pattern as issue #3754
 * (koala73/worldmonitor) which only named the sibling list-company-signals
 * route; this handler had the identical bug.
 *
 * The route is preserved (proto contract, OpenAPI op, gateway entry) so
 * existing callers keep working. The handler now returns an empty envelope.
 * Re-enable only behind a verified attribution model (maintained company-to-
 * code-host registry plus proper filer-CIK matching), never with another
 * domain-slug heuristic.
 */

import type {
  ServerContext,
  GetCompanyEnrichmentRequest,
  GetCompanyEnrichmentResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

export async function getCompanyEnrichment(
  _ctx: ServerContext,
  req: GetCompanyEnrichmentRequest,
): Promise<GetCompanyEnrichmentResponse> {
  const domain = req.domain?.trim().toLowerCase();
  const name = req.name?.trim();

  if (!domain && !name) {
    throw new ValidationError([{ field: 'domain', description: 'Provide domain or name' }]);
  }

  return {
    company: {
      name: name || '',
      domain: domain || '',
      description: '',
      location: '',
      website: domain ? `https://${domain}` : '',
      founded: 0,
    },
    github: undefined,
    techStack: [],
    secFilings: undefined,
    hackerNewsMentions: [],
    enrichedAtMs: Date.now(),
    sources: [],
  };
}
