/**
 * Market-alert core — the four market-alert detectors (prediction_leads_news,
 * explained_market_move, silent_divergence, flow_price_divergence), the
 * pipeline flow-drop detector and their thresholds, moved verbatim from
 * src/services/analysis-core.ts and src/utils/analysis-constants.ts (which
 * re-export from here) so a Railway seeder emits the same alerts the dashboard
 * shows (issue #8867).
 *
 * ESM, depends only on ./text-analysis-core.js and ./entity-extraction-core.js.
 * Types in market-alert-core.d.ts.
 */

import { TOPIC_KEYWORDS, SUPPRESSED_TRENDING_TERMS, includesKeyword, containsTopicKeyword } from './text-analysis-core.js';
import { getEntityIndex } from './entity-extraction-core.js';

export const MARKET_ALERT_TYPES = Object.freeze([
  'prediction_leads_news',
  'explained_market_move',
  'silent_divergence',
  'flow_price_divergence',
]);

// Correlation constants
export const PREDICTION_SHIFT_THRESHOLD = 5;
export const MARKET_MOVE_THRESHOLD = 2;
export const NEWS_VELOCITY_THRESHOLD = 3;
export const FLOW_PRICE_THRESHOLD = 1.5;
export const ENERGY_COMMODITY_SYMBOLS = new Set(['CL=F', 'NG=F']);

export const PIPELINE_KEYWORDS = ['pipeline', 'pipelines', 'line', 'terminal'];
export const FLOW_DROP_KEYWORDS = [
  'flow', 'throughput', 'capacity', 'outage', 'leak', 'rupture', 'shutdown',
  'maintenance', 'curtailment', 'force majeure', 'halt', 'halted', 'reduced',
  'reduction', 'drop', 'offline', 'suspend', 'suspended', 'stoppage',
];

export const TOPIC_MAPPINGS = {
  'iran': ['iran', 'israel', 'oil', 'sanctions'],
  'israel': ['israel', 'iran', 'war', 'gaza'],
  'ukraine': ['ukraine', 'russia', 'war', 'nato'],
  'russia': ['russia', 'ukraine', 'sanctions'],
  'china': ['china', 'taiwan', 'tariff', 'trade'],
  'taiwan': ['taiwan', 'china'],
  'trump': ['trump', 'election', 'tariff'],
  'fed': ['fed', 'interest', 'inflation', 'recession'],
  'bitcoin': ['crypto', 'bitcoin'],
  'recession': ['recession', 'fed', 'inflation'],
};

export function findRelatedTopics(prediction) {
  const title = prediction.toLowerCase();
  const related = [];

  for (const [key, topics] of Object.entries(TOPIC_MAPPINGS)) {
    if (containsTopicKeyword(title, key)) {
      related.push(...topics);
    }
  }

  return [...new Set(related)];
}

export function generateSignalId() {
  return `sig-${crypto.randomUUID()}`;
}

export function generateDedupeKey(type, identifier, value) {
  // Market signals dedupe by symbol only (not by change value)
  // This prevents duplicates when price fluctuates slightly
  const marketSignals = ['silent_divergence', 'flow_price_divergence', 'explained_market_move'];
  if (marketSignals.includes(type)) {
    return `${type}:${identifier}`;
  }
  const roundedValue = Math.round(value * 10) / 10;
  return `${type}:${identifier}:${roundedValue}`;
}

/**
 * Snapshot key for one prediction market (#8868). A title prefix is not an
 * identity: dated variants of one question ("... by March 31?" / "... by June
 * 30?") share long prefixes, and Polymarket rows drawn from one event share the
 * event URL, so neither the prefix nor the URL alone tells two markets apart.
 * The URL plus the full title does. Unique URL-backed titles also store a
 * namespaced alias so a later poll that loses the URL can still find the
 * previous price. Duplicate URL-less titles are omitted from the snapshot
 * rather than overwriting one previous price.
 */
export function predictionMarketKey(market) {
  const url = market.url?.trim();
  return url ? `${url}|${market.title}` : market.title;
}

/** Internal snapshot alias for a unique URL-backed title. Not a market identity. */
const TITLE_ALIAS_PREFIX = '\0title:';

function titleAliasKey(title) {
  return `${TITLE_ALIAS_PREFIX}${title}`;
}

function titleCounts(predictions) {
  const counts = new Map();
  for (const pred of predictions) {
    counts.set(pred.title, (counts.get(pred.title) ?? 0) + 1);
  }
  return counts;
}

function isUniqueTitle(counts, title) {
  return counts.get(title) === 1;
}

export function predictionChangesSnapshot(predictions) {
  const counts = titleCounts(predictions);
  const snapshot = new Map();
  for (const pred of predictions) {
    const url = pred.url?.trim();
    // Duplicate URL-less titles share one key; storing either price would
    // make a later URL-gain look like a shift against the other market.
    if (!url && !isUniqueTitle(counts, pred.title)) continue;
    snapshot.set(predictionMarketKey(pred), pred.yesPrice);
    if (url && isUniqueTitle(counts, pred.title)) {
      snapshot.set(titleAliasKey(pred.title), pred.yesPrice);
    }
  }
  return snapshot;
}

export function previousPredictionPrice(pred, previous, currentCounts) {
  const url = pred.url?.trim();
  if (!url && !isUniqueTitle(currentCounts, pred.title)) return undefined;
  const key = predictionMarketKey(pred);
  const exact = previous.get(key);
  if (exact !== undefined) return exact;
  if (!isUniqueTitle(currentCounts, pred.title)) return undefined;
  // URL gained: previous poll stored the URL-less title key only if unique.
  // URL lost: previous poll stored a namespaced unique-title alias.
  return url ? previous.get(pred.title) : previous.get(titleAliasKey(pred.title));
}

export function extractTopics(events) {
  const topics = new Map();

  for (const event of events) {
    const title = event.primaryTitle.toLowerCase();
    for (const kw of TOPIC_KEYWORDS) {
      if (SUPPRESSED_TRENDING_TERMS.has(kw)) continue;
      if (!containsTopicKeyword(title, kw)) continue;
      const velocity = event.velocity?.sourcesPerHour ?? 0;
      topics.set(kw, (topics.get(kw) ?? 0) + velocity + event.sourceCount);
    }
  }

  return topics;
}

export function countRelatedTopicMentions(newsTopics, market) {
  const marketNameLower = market.name.toLowerCase();
  const marketSymbolLower = market.symbol.toLowerCase();
  return Array.from(newsTopics.entries())
    .filter(([topic]) => marketNameLower.includes(topic) || topic.includes(marketSymbolLower))
    .reduce((sum, [, velocity]) => sum + velocity, 0);
}

export function detectPipelineFlowDrops(events, isRecentDuplicate, markSignalSeen) {
  const signals = [];

  for (const event of events) {
    const titles = [
      event.primaryTitle,
      ...(event.allItems?.map(item => item.title) ?? []),
    ]
      .map(title => title.toLowerCase())
      .filter(Boolean);

    const hasPipeline = titles.some(title => includesKeyword(title, PIPELINE_KEYWORDS));
    const hasFlowDrop = titles.some(title => includesKeyword(title, FLOW_DROP_KEYWORDS));

    if (hasPipeline && hasFlowDrop) {
      const dedupeKey = generateDedupeKey('flow_drop', event.id, event.sourceCount);
      if (!isRecentDuplicate(dedupeKey)) {
        markSignalSeen(dedupeKey);
        signals.push({
          id: generateSignalId(),
          type: 'flow_drop',
          title: 'Pipeline Flow Drop',
          description: `"${event.primaryTitle.slice(0, 70)}..." indicates reduced flow or disruption`,
          confidence: Math.min(0.9, 0.4 + event.sourceCount / 10),
          timestamp: new Date(),
          data: {
            newsVelocity: event.sourceCount,
            relatedTopics: ['pipeline', 'flow'],
          },
        });
      }
    }
  }

  return signals;
}

export function findNewsForEntity(entityId, newsContexts) {
  const index = getEntityIndex();
  const entity = index.byId.get(entityId);
  if (!entity) return [];

  const relatedIds = new Set([entityId, ...(entity.related ?? [])]);

  const matches = [];

  for (const [clusterId, context] of newsContexts) {
    const directMatch = context.entities.find(e => e.entityId === entityId);
    if (directMatch) {
      matches.push({
        clusterId,
        title: context.title,
        confidence: directMatch.confidence,
      });
      continue;
    }

    const relatedMatch = context.entities.find(e => relatedIds.has(e.entityId));
    if (relatedMatch) {
      matches.push({
        clusterId,
        title: context.title,
        confidence: relatedMatch.confidence * 0.8,
      });
    }
  }

  return matches.sort((a, b) => b.confidence - a.confidence);
}

export function findNewsForMarketSymbol(symbol, newsContexts) {
  return findNewsForEntity(symbol, newsContexts);
}

export function detectMarketAlerts({
  markets,
  predictions,
  previousPredictionChanges,
  newsTopics,
  newsEntityContexts,
  pipelineFlowMentions,
  isRecentDuplicate,
  markSignalSeen,
}) {
  const signals = [];
  const currentTitleCounts = titleCounts(predictions);
  const entityIndex = getEntityIndex();

  // Detect prediction shifts
  if (previousPredictionChanges) {
    for (const pred of predictions) {
      const key = predictionMarketKey(pred);
      const prev = previousPredictionPrice(pred, previousPredictionChanges, currentTitleCounts);
      if (prev !== undefined) {
        // Keep the sign (#8868): a fall must read as a fall. Only the threshold
        // and the confidence work on the magnitude.
        const shift = pred.yesPrice - prev;
        const magnitude = Math.abs(shift);
        if (magnitude >= PREDICTION_SHIFT_THRESHOLD) {
          const related = findRelatedTopics(pred.title);
          const newsActivity = related.reduce((sum, t) => sum + (newsTopics.get(t) ?? 0), 0);

          const dedupeKey = generateDedupeKey('prediction_leads_news', key, shift);
          if (newsActivity < NEWS_VELOCITY_THRESHOLD && !isRecentDuplicate(dedupeKey)) {
            markSignalSeen(dedupeKey);
            signals.push({
              id: generateSignalId(),
              type: 'prediction_leads_news',
              title: 'Prediction Market Shift',
              description: `"${pred.title.slice(0, 60)}..." moved ${shift > 0 ? '+' : ''}${shift.toFixed(1)}% with low news coverage`,
              confidence: Math.min(0.9, 0.5 + magnitude / 20),
              timestamp: new Date(),
              data: {
                predictionShift: shift,
                newsVelocity: newsActivity,
                relatedTopics: related,
              },
            });
          }
        }
      }
    }
  }

  // Detect market moves with entity-aware news correlation
  for (const market of markets) {
    const change = Math.abs(market.change ?? 0);
    if (change < MARKET_MOVE_THRESHOLD) continue;

    const entity = entityIndex.byId.get(market.symbol);
    const relatedNews = findNewsForMarketSymbol(market.symbol, newsEntityContexts);

    if (relatedNews.length > 0) {
      const topNews = relatedNews[0];
      const dedupeKey = generateDedupeKey('explained_market_move', market.symbol, change);
      if (!isRecentDuplicate(dedupeKey)) {
        markSignalSeen(dedupeKey);
        const direction = market.change > 0 ? '+' : '';
        signals.push({
          id: generateSignalId(),
          type: 'explained_market_move',
          title: 'Market Move Explained',
          description: `${market.name} ${direction}${market.change.toFixed(2)}% correlates with: "${topNews.title.slice(0, 60)}..."`,
          confidence: Math.min(0.9, 0.5 + (relatedNews.length * 0.1) + (change / 20)),
          timestamp: new Date(),
          data: {
            marketChange: market.change,
            newsVelocity: relatedNews.length,
            correlatedEntities: [market.symbol],
            correlatedNews: relatedNews.map(n => n.clusterId),
            explanation: `${relatedNews.length} related news item${relatedNews.length > 1 ? 's' : ''} found`,
          },
        });
      }
    } else {
      const oldRelatedNews = countRelatedTopicMentions(newsTopics, market);

      const dedupeKey = generateDedupeKey('silent_divergence', market.symbol, change);
      if (oldRelatedNews < 2 && !isRecentDuplicate(dedupeKey)) {
        markSignalSeen(dedupeKey);
        const searchedTerms = entity
          ? [market.symbol, market.name, ...(entity.keywords?.slice(0, 2) ?? [])].join(', ')
          : market.symbol;
        signals.push({
          id: generateSignalId(),
          type: 'silent_divergence',
          title: 'Silent Divergence',
          description: `${market.name} moved ${market.change > 0 ? '+' : ''}${market.change.toFixed(2)}% - no news found for: ${searchedTerms}`,
          confidence: Math.min(0.8, 0.4 + change / 10),
          timestamp: new Date(),
          data: {
            marketChange: market.change,
            newsVelocity: oldRelatedNews,
            explanation: `Searched: ${searchedTerms}`,
          },
        });
      }
    }
  }

  // Detect flow/price divergence for energy commodities
  for (const market of markets) {
    if (!ENERGY_COMMODITY_SYMBOLS.has(market.symbol)) continue;

    const change = market.change ?? 0;
    if (change >= FLOW_PRICE_THRESHOLD) {
      const relatedNews = countRelatedTopicMentions(newsTopics, market);

      const dedupeKey = generateDedupeKey('flow_price_divergence', market.symbol, change);
      if (relatedNews < 2 && pipelineFlowMentions === 0 && !isRecentDuplicate(dedupeKey)) {
        markSignalSeen(dedupeKey);
        signals.push({
          id: generateSignalId(),
          type: 'flow_price_divergence',
          title: 'Flow/Price Divergence',
          description: `${market.name} up ${change.toFixed(2)}% without pipeline flow news`,
          confidence: Math.min(0.85, 0.4 + change / 8),
          timestamp: new Date(),
          data: {
            marketChange: change,
            newsVelocity: relatedNews,
            relatedTopics: ['pipeline', market.display],
          },
        });
      }
    }
  }

  return signals;
}
