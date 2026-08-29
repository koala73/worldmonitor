import type {
  ListFiveFactorScorecardsRequest,
  ListFiveFactorScorecardsResponse,
  ScorecardServiceHandler,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/scorecard/v1/service_server';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';
import { asFiveFactorSnapshot, readFiveFactorSnapshot, type ScorecardSnapshotReader } from './_read-snapshot';
import { toPublicCountryScorecard } from './_response';

export async function listFiveFactorScorecardsWithReader(
  ctx: ServerContext,
  _req: ListFiveFactorScorecardsRequest,
  reader: ScorecardSnapshotReader,
): Promise<ListFiveFactorScorecardsResponse> {
  try {
    const snapshot = asFiveFactorSnapshot(await reader());
    if (!snapshot) {
      return markNoStoreFallbackResponse(ctx.request, {
        scorecards: [],
        unavailable: true,
        unavailableReason: 'scorecard-snapshot-unavailable',
        methodologyVersion: '',
        computedAt: '',
      });
    }
    return {
      scorecards: Object.entries(snapshot.countries)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, record]) => toPublicCountryScorecard(record.result, snapshot.computedAt)),
      unavailable: false,
      unavailableReason: '',
      methodologyVersion: snapshot.methodologyVersion,
      computedAt: snapshot.computedAt,
    };
  } catch {
    return markNoStoreFallbackResponse(ctx.request, {
      scorecards: [],
      unavailable: true,
      unavailableReason: 'scorecard-snapshot-unavailable',
      methodologyVersion: '',
      computedAt: '',
    });
  }
}

export const listFiveFactorScorecards: ScorecardServiceHandler['listFiveFactorScorecards'] = (ctx, req) =>
  listFiveFactorScorecardsWithReader(ctx, req, readFiveFactorSnapshot);
