import type { IntelligenceServiceHandler } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getRiskScores } from './get-risk-scores';
import { getPizzintStatus } from './get-pizzint-status';
import { classifyEvent } from './classify-event';
import { getCountryIntelBrief } from './get-country-intel-brief';
import { searchGdeltDocuments } from './search-gdelt-documents';

export const intelligenceHandler: IntelligenceServiceHandler = {
  getRiskScores,
  getPizzintStatus,
  classifyEvent,
  getCountryIntelBrief,
  searchGdeltDocuments,
};
