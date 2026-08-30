import type {
  ListFiveFactorScorecardsRequest,
  ListFiveFactorScorecardsResponse,
  ScorecardServiceHandler,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/scorecard/v1/service_server';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../../../../api/_sentry-edge.js';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';
import { asFiveFactorSnapshot, createFiveFactorReadDeadline, readFiveFactorListProjection, readFiveFactorSnapshot, type ScorecardSnapshotReader } from './_read-snapshot';
import { toPublicCountryScorecardSummary, toPublicStoredCountryScorecardSummary } from './_response';

export async function listFiveFactorScorecardsWithReader(
  ctx: ServerContext,
  _req: ListFiveFactorScorecardsRequest,
  reader: ScorecardSnapshotReader,
): Promise<ListFiveFactorScorecardsResponse> {
  let snapshotValue: unknown;
  try {
    snapshotValue = await reader();
  } catch (error) {
    console.warn('[scorecard] snapshot read failed operation=list-five-factor-scorecards', error instanceof Error ? error.message : 'unknown');
    void captureSilentError(error, { tags: { route: 'scorecard/list-five-factor-scorecards', step: 'snapshot-read' } });
    return markNoStoreFallbackResponse(ctx.request, {
      scorecards: [],
      unavailable: true,
      unavailableReason: 'scorecard-snapshot-unavailable',
      methodologyVersion: '',
      computedAt: '',
    });
  }
  const snapshot = asFiveFactorSnapshot(snapshotValue);
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
      .map(([, record]) => toPublicCountryScorecardSummary(record.result)),
    unavailable: false,
    unavailableReason: '',
    methodologyVersion: snapshot.methodologyVersion,
    computedAt: snapshot.computedAt,
  };
}

export async function listFiveFactorScorecardsWithReadModel(
  ctx: ServerContext,
  req: ListFiveFactorScorecardsRequest,
  dependencies: {
    createDeadline?: () => number;
    readProjection?: typeof readFiveFactorListProjection;
    readSnapshot?: typeof readFiveFactorSnapshot;
  } = {},
): Promise<ListFiveFactorScorecardsResponse> {
  const deadlineAtMs = (dependencies.createDeadline ?? createFiveFactorReadDeadline)();
  const projection = await (dependencies.readProjection ?? readFiveFactorListProjection)(deadlineAtMs);
  if (!projection) {
    const snapshotReader = dependencies.readSnapshot ?? readFiveFactorSnapshot;
    return listFiveFactorScorecardsWithReader(ctx, req, (countryCodes) => snapshotReader(countryCodes, deadlineAtMs));
  }
  return {
    scorecards: projection.scorecards.map(toPublicStoredCountryScorecardSummary),
    unavailable: false,
    unavailableReason: '',
    methodologyVersion: projection.metadata.methodologyVersion,
    computedAt: projection.metadata.computedAt,
  };
}

export const listFiveFactorScorecards: ScorecardServiceHandler['listFiveFactorScorecards'] = (ctx, req) =>
  listFiveFactorScorecardsWithReadModel(ctx, req);
