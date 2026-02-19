/**
 * Unified intelligence service module.
 *
 * Re-exports from legacy service files that have complex client-side logic
 * (DEFCON calculation, circuit breakers, batch classification, GDELT DOC API).
 * Server-side edge functions are consolidated in the handler.
 */

// PizzINT dashboard + GDELT tensions
export {
  fetchPizzIntStatus,
  fetchGdeltTensions,
  getPizzIntStatus,
  getGdeltStatus,
} from '../pizzint';

// Risk scores (CII + strategic risk)
export {
  fetchCachedRiskScores,
  getCachedScores,
  hasCachedScores,
  toCountryScore,
} from '../cached-risk-scores';
export type { CachedCIIScore, CachedStrategicRisk, CachedRiskScores } from '../cached-risk-scores';

// Threat classification (keyword + AI)
export {
  classifyByKeyword,
  classifyWithAI,
  aggregateThreats,
  THREAT_PRIORITY,
} from '../threat-classifier';
export type { ThreatClassification, ThreatLevel, EventCategory } from '../threat-classifier';

// GDELT intelligence
export {
  fetchGdeltArticles,
  fetchTopicIntelligence,
  fetchAllTopicIntelligence,
  fetchHotspotContext,
  formatArticleDate,
  extractDomain,
} from '../gdelt-intel';
export type { GdeltArticle } from '../gdelt-intel';
