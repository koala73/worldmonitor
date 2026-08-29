import type {
  GetBlocScorecardRequest,
  GetBlocScorecardResponse,
  ScorecardServiceHandler,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/scorecard/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/scorecard/v1/service_server';
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
  try {
    const snapshot = asFiveFactorSnapshot(await reader());
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
  } catch {
    return markNoStoreFallbackResponse(ctx.request, {
      unavailable: true,
      unavailableReason: 'scorecard-snapshot-unavailable',
    });
  }
}

export const getBlocScorecard: ScorecardServiceHandler['getBlocScorecard'] = (ctx, req) =>
  getBlocScorecardWithReader(ctx, req, readFiveFactorSnapshot);
