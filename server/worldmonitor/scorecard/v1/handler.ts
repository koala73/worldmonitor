import type { ScorecardServiceHandler } from '../../../../src/generated/server/worldmonitor/scorecard/v1/service_server';
import { getBlocScorecard } from './get-bloc-scorecard';
import { getFiveFactorScorecard } from './get-five-factor-scorecard';
import { listFiveFactorScorecards } from './list-five-factor-scorecards';

export const scorecardHandler: ScorecardServiceHandler = {
  getFiveFactorScorecard,
  listFiveFactorScorecards,
  getBlocScorecard,
};
