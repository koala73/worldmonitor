import type {
  GetBlocScorecardRequest,
  GetBlocScorecardResponse,
  ScorecardServiceHandler,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/scorecard/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/scorecard/v1/service_server';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../../../../api/_sentry-edge.js';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';
import { resolveBlocSelection } from './_bloc-presets';
import { asFiveFactorSnapshot, readFiveFactorSnapshot, type ScorecardSnapshotReader } from './_read-snapshot';
import { toPublicBlocScorecard } from './_response';
import { scoreBloc } from './_score-bloc';
import type { CountryScorecardEvidence } from './_types';

export async function getBlocScorecardWithReader(
  ctx: ServerContext,
  req: GetBlocScorecardRequest,
  reader: ScorecardSnapshotReader,
): Promise<GetBlocScorecardResponse> {
  let selection;
  try {
    selection = resolveBlocSelection(req);
  } catch (error) {
    throw new ValidationError([{
      field: req.preset ? 'preset' : 'members',
      description: error instanceof Error ? error.message : 'Invalid scorecard bloc selection.',
    }]);
  }
  let snapshotValue: unknown;
  try {
    snapshotValue = await reader(selection.members);
  } catch (error) {
    console.warn('[scorecard] snapshot read failed operation=get-bloc-scorecard', error instanceof Error ? error.message : 'unknown');
    void captureSilentError(error, { tags: { route: 'scorecard/get-bloc-scorecard', step: 'snapshot-read' } });
    return markNoStoreFallbackResponse(ctx.request, {
      unavailable: true,
      unavailableReason: 'scorecard-snapshot-unavailable',
    });
  }
  const snapshot = asFiveFactorSnapshot(snapshotValue);
  if (!snapshot) {
    return markNoStoreFallbackResponse(ctx.request, {
      unavailable: true,
      unavailableReason: 'scorecard-snapshot-unavailable',
    });
  }
  const missingMembers = selection.members
    .filter((countryCode) => snapshot.countries[countryCode] == null)
    .map((countryCode) => ({ countryCode, reason: 'country-unavailable' as const }));
  const members = selection.members
    .map((countryCode) => snapshot.countries[countryCode]?.evidence)
    .filter((evidence): evidence is CountryScorecardEvidence => evidence != null);
  if (members.length < 2) {
    return markNoStoreFallbackResponse(ctx.request, {
      unavailable: true,
      unavailableReason: 'bloc-members-unavailable',
    });
  }
  const result = scoreBloc({
    id: selection.id,
    label: selection.label,
    members,
    requestedMembers: selection.members,
    unavailableMembers: missingMembers,
  });
  return {
    scorecard: toPublicBlocScorecard(result, snapshot.computedAt),
    unavailable: false,
    unavailableReason: '',
  };
}

export const getBlocScorecard: ScorecardServiceHandler['getBlocScorecard'] = (ctx, req) =>
  getBlocScorecardWithReader(ctx, req, readFiveFactorSnapshot);
