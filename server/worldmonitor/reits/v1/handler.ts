/**
 * REIT service handler -- thin composition of per-RPC modules.
 *
 * RPCs:
 *   - ListReitQuotes          (Yahoo Finance REIT quotes + regime + AI briefing)
 *   - GetReitCorrelation      (FRED macro correlation + sector rotation + yield spread)
 *   - ListReitProperties      (curated property locations + disaster exposure scores)
 *   - GetReitSocialSentiment  (Google Places/Yelp social health scores)
 */

import type { ReitsServiceHandler } from '../../../../src/generated/server/worldmonitor/reits/v1/service_server';
import { listReitQuotes } from './list-reit-quotes';
import { getReitCorrelation } from './get-reit-correlation';
import { listReitProperties } from './list-reit-properties';
import { getReitSocialSentiment } from './get-reit-social-sentiment';

export const reitsHandler: ReitsServiceHandler = {
  listReitQuotes,
  getReitCorrelation,
  listReitProperties,
  getReitSocialSentiment,
};
