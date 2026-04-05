import type { IntelligenceServiceHandler } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getRiskScores } from './get-risk-scores';
import { getCountryRisk } from './get-country-risk';
import { getPizzintStatus } from './get-pizzint-status';
import { classifyEvent } from './classify-event';
import { getCountryIntelBrief } from './get-country-intel-brief';
import { searchGdeltDocuments } from './search-gdelt-documents';
import { deductSituation } from './deduct-situation';
import { getCountryFacts } from './get-country-facts';
import { listSecurityAdvisories } from './list-security-advisories';
import { listSatellites } from './list-satellites';
import { listGpsInterference } from './list-gps-interference';
import { listOrefAlerts } from './list-oref-alerts';
import { listTelegramFeed } from './list-telegram-feed';
import { getCompanyEnrichment } from './get-company-enrichment';
import { listCompanySignals } from './list-company-signals';
import { getGdeltTopicTimeline } from './get-gdelt-topic-timeline';
import { listCrossSourceSignals } from './list-cross-source-signals';
import { listMarketImplications } from './list-market-implications';
import { getSocialVelocity } from './get-social-velocity';
import { getCountryEnergyProfile } from './get-country-energy-profile';

export const intelligenceHandler: IntelligenceServiceHandler = {
  getRiskScores,
  getCountryRisk,
  getPizzintStatus,
  classifyEvent,
  getCountryIntelBrief,
  searchGdeltDocuments,
  deductSituation,
  getCountryFacts,
  listSecurityAdvisories,
  listSatellites,
  listGpsInterference,
  listOrefAlerts,
  listTelegramFeed,
  getCompanyEnrichment,
  listCompanySignals,
  getGdeltTopicTimeline,
  listCrossSourceSignals,
  listMarketImplications,
  getSocialVelocity,
  getCountryEnergyProfile,
};
