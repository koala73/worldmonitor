import type {
  GetFiveFactorScorecardRequest,
  GetFiveFactorScorecardResponse,
  ScorecardServiceHandler,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/scorecard/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/scorecard/v1/service_server';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';
import { asFiveFactorSnapshot, readFiveFactorSnapshot, type ScorecardSnapshotReader } from './_read-snapshot';
import { toPublicCountryScorecard } from './_response';

export async function getFiveFactorScorecardWithReader(
  ctx: ServerContext,
  req: GetFiveFactorScorecardRequest,
  reader: ScorecardSnapshotReader,
): Promise<GetFiveFactorScorecardResponse> {
  const countryCode = String(req.countryCode || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw new ValidationError([{ field: 'countryCode', description: 'countryCode must be a 2-letter ISO 3166-1 alpha-2 code' }]);
  }
  try {
    const snapshot = asFiveFactorSnapshot(await reader());
    const record = snapshot?.countries[countryCode];
    if (!snapshot || !record) {
      return markNoStoreFallbackResponse(ctx.request, {
        unavailable: true,
        unavailableReason: snapshot ? 'country-unavailable' : 'scorecard-snapshot-unavailable',
      });
    }
    return {
      scorecard: toPublicCountryScorecard(record.result, snapshot.computedAt),
      unavailable: false,
      unavailableReason: '',
    };
  } catch {
    return markNoStoreFallbackResponse(ctx.request, {
      unavailable: true,
      unavailableReason: 'scorecard-snapshot-unavailable',
    });
  }
}

export const getFiveFactorScorecard: ScorecardServiceHandler['getFiveFactorScorecard'] = (ctx, req) =>
  getFiveFactorScorecardWithReader(ctx, req, readFiveFactorSnapshot);
