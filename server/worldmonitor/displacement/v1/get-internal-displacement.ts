import type {
  ServerContext,
  GetInternalDisplacementRequest,
  GetInternalDisplacementResponse,
  InternalDisplacementOperation,
} from '../../../../src/generated/server/worldmonitor/displacement/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/displacement/v1/service_server';
import { readCachedEnvelopeJson } from '../../../_shared/redis';
import { unwrapEnvelope } from '../../../_shared/seed-envelope';

export const DTM_CANONICAL_KEY = 'displacement:dtm:v1';

// Railway (scripts/seed-dtm-displacement.mjs) owns fetching and aggregation;
// this handler only selects from the published snapshot.
export async function getInternalDisplacement(
  _ctx: ServerContext,
  req: GetInternalDisplacementRequest,
): Promise<GetInternalDisplacementResponse> {
  const countryCode = (req.countryCode ?? '').trim().toUpperCase();
  if (countryCode && !/^[A-Z]{3}$/.test(countryCode)) {
    throw new ValidationError([{ field: 'countryCode', description: 'country_code must be an ISO 3166-1 alpha-3 code' }]);
  }
  const emptyResponse: GetInternalDisplacementResponse = { operations: [], fetchedAt: 0, dataAvailable: false };

  try {
    const seedRead = await readCachedEnvelopeJson(DTM_CANONICAL_KEY, true);
    if (seedRead.status !== 'hit') return emptyResponse;
    const envelope = unwrapEnvelope(seedRead.value);
    const data = envelope.data as { operations?: InternalDisplacementOperation[] } | null;
    const fetchedAt = envelope._seed?.fetchedAt;
    if (!Array.isArray(data?.operations) || !Number.isFinite(fetchedAt)) return emptyResponse;
    const operations = countryCode
      ? data.operations.filter((op) => op.countryCode === countryCode)
      : data.operations;
    return { operations, fetchedAt: fetchedAt ?? 0, dataAvailable: true };
  } catch {
    return emptyResponse;
  }
}
