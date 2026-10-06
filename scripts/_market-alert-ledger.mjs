/**
 * Market-alert ledger (#8867): the pure steps behind
 * scripts/seed-market-alert-ledger.mjs. Each emitted market alert opens a
 * six-hour window keyed `${type}:${entity}@${deadline}`; a closed window is
 * resolved against the English digest archive under MARKET_ALERT_RESOLUTION_RULE.
 * Redis never appears here: the archive is injected, so tests run on fixtures.
 */

import { MARKET_ALERT_TYPES, predictionMarketKey } from './shared/market-alert-core.js';
import { findEntitiesInText, getEntityIndex, lookupEntityByAlias } from './shared/entity-extraction-core.js';
import { SUPPRESSED_TRENDING_TERMS, TOPIC_KEYWORDS, containsTopicKeyword, escapeRegex } from './shared/text-analysis-core.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const MARKET_ALERT_LEDGER_KEY = 'correlation:market-alerts:ledger:v1';
export const MARKET_ALERT_SCORECARD_KEY = 'correlation:market-alerts:scorecard:v1';
export const MARKET_ALERT_SNAPSHOT_KEY = 'correlation:market-alerts:snapshot:v1';
export const MARKET_ALERT_SEED_META_KEY = 'seed-meta:correlation:market-alerts';
export const MARKET_ALERT_SCORECARD_META_KEY = 'seed-meta:correlation:market-alerts-scorecard';
export const MARKET_ALERT_SNAPSHOT_META_KEY = 'seed-meta:correlation:market-alerts-snapshot';
export const MARKET_ALERT_ACTIVATION_KEY = 'seed-activated:correlation:market-alerts';
export const MARKET_ALERT_COMPLETION_META_KEY = 'seed-completion:correlation:market-alerts';

export const MARKET_ALERT_WINDOW_MS = 6 * HOUR_MS;
export const MARKET_ALERT_EVIDENCE_EXPIRY_MS = 6 * DAY_MS;
export const MARKET_ALERT_ROLLING_WINDOW_DAYS = 30;
export const MARKET_ALERT_LEDGER_RETENTION_MS = MARKET_ALERT_ROLLING_WINDOW_DAYS * DAY_MS;
export const MARKET_ALERT_CONFIDENCE_GATE = 0.6;
export const MARKET_ALERT_HIT_MAX_TIER = 2;
export const MARKET_ALERT_MAX_DESCRIPTION_CHARS = 200;
export const MARKET_ALERT_LEDGER_SOURCE_VERSION = 'market-alert-ledger-v1';
export const MARKET_ALERT_LEDGER_SCHEMA_VERSION = 1;

export const MARKET_ALERT_RESOLUTION_RULE = 'An emission resolves HIT when a story first tracked by the English news digest within six hours after the emission has at least one Tier 1 or Tier 2 source and its title names the same entity: for a market, an alias match for the symbol\'s registry entity or a whole-word match of the market name of four or more characters; for a prediction market, any topic keyword derived from the question at emission. It resolves MISS when six hours pass with no such story. It resolves VOID, and is not counted, when the story archive for its window expired before the resolver read it. Lead time is the gap between emission and the matching story\'s first tracking.';

const ALERT_TYPES = new Set(MARKET_ALERT_TYPES);

function pruneUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

export function sortLedger(ledger) {
  return Object.fromEntries(Object.entries(ledger).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function entityForMarket(market) {
  const index = getEntityIndex();
  const entityId = index.byId.has(market.symbol)
    ? market.symbol
    : (lookupEntityByAlias(market.symbol.toLowerCase(), index)?.id ?? null);
  return { kind: 'market', symbol: market.symbol, name: market.name, entityId };
}

export function entityForPrediction(prediction, relatedTopics = []) {
  const titleLower = prediction.title.toLowerCase();
  const topics = new Set(relatedTopics);
  for (const keyword of TOPIC_KEYWORDS) {
    if (!SUPPRESSED_TRENDING_TERMS.has(keyword) && containsTopicKeyword(titleLower, keyword)) topics.add(keyword);
  }
  return pruneUndefined({ kind: 'prediction', title: prediction.title, url: prediction.url || undefined, relatedTopics: [...topics] });
}

function findOpenWindow(ledger, id, nowMs) {
  return Object.values(ledger).find((entry) => entry.status === 'pending' && entry.id === id && nowMs < entry.deadline);
}

function createEntry(signal, entity, nowMs, runtimeMode) {
  const id = `${signal.type}:${signal.data.correlatedEntities[0]}`;
  const deadline = nowMs + MARKET_ALERT_WINDOW_MS;
  return pruneUndefined({
    id,
    key: `${id}@${deadline}`,
    type: signal.type,
    entity,
    emittedAt: nowMs,
    deadline,
    observedChange: signal.data.marketChange ?? signal.data.predictionShift,
    newsVelocity: signal.data.newsVelocity,
    confidence: signal.confidence,
    runtimeMode,
    description: String(signal.description ?? '').slice(0, MARKET_ALERT_MAX_DESCRIPTION_CHARS),
    firstSeenAt: nowMs,
    lastSeenAt: nowMs,
    samples: 0,
    status: 'pending',
  });
}

export function ingestSignals(existing, signals, { nowMs, runtimeMode, markets, predictions }) {
  const ledger = { ...existing };
  const marketsBySymbol = new Map(markets.map((market) => [market.symbol, market]));
  const predictionsByKey = new Map(predictions.map((prediction) => [predictionMarketKey(prediction), prediction]));
  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const signal of signals) {
    const entityKey = signal.data?.correlatedEntities?.[0];
    if (!ALERT_TYPES.has(signal.type) || !(signal.confidence >= MARKET_ALERT_CONFIDENCE_GATE) || !entityKey) {
      skipped += 1;
      continue;
    }
    const open = findOpenWindow(ledger, `${signal.type}:${entityKey}`, nowMs);
    if (open) {
      ledger[open.key] = { ...open, lastSeenAt: nowMs, samples: open.samples + 1 };
      updated += 1;
      continue;
    }
    const entity = signal.type === 'prediction_leads_news'
      ? entityForPrediction(predictionsByKey.get(entityKey), signal.data.relatedTopics)
      : entityForMarket(marketsBySymbol.get(entityKey));
    const entry = createEntry(signal, entity, nowMs, runtimeMode);
    ledger[entry.key] = entry;
    created += 1;
  }
  return { ledger: sortLedger(ledger), created, updated, skipped };
}

export function storyMatchesEntity(title, entity, entityMatches) {
  if (entity.kind === 'prediction') {
    const titleLower = title.toLowerCase();
    return entity.relatedTopics.some((topic) => containsTopicKeyword(titleLower, topic));
  }
  if (entity.entityId) {
    const matches = entityMatches ?? findEntitiesInText(title);
    if (matches.some((match) => match.matchType === 'alias' && match.entityId === entity.entityId)) return true;
  }
  return entity.name.length >= 4 && new RegExp(`\\b${escapeRegex(entity.name)}\\b`, 'i').test(title);
}

function resolveEntry(entry, outcome, nowMs, evidence) {
  return { ...entry, status: 'resolved', outcome, resolvedAt: nowMs, evidence };
}

function countPending(ledger) {
  return Object.values(ledger).filter((entry) => entry.status === 'pending').length;
}

function resolution(ledger, counts, readFailed) {
  return { ledger: sortLedger(ledger), ...counts, pending: countPending(ledger), readFailed };
}

/**
 * VOID is a clock verdict and needs no archive read. Everything else fails
 * closed: a null story or source read leaves the due entries pending for the
 * next tick rather than scoring them against a partial archive. A window is
 * scored only when the archive still holds a story last seen at or before the
 * window opened, because an accumulator that expired and was rebuilt cannot
 * prove absence.
 */
export async function resolveDueEntries(existing, { nowMs, archive }) {
  const ledger = { ...existing };
  const counts = { hit: 0, miss: 0, void: 0, unproven: 0 };
  const resolvable = [];
  for (const entry of Object.values(ledger)) {
    if (entry.status !== 'pending' || entry.deadline >= nowMs) continue;
    if (entry.deadline < nowMs - MARKET_ALERT_EVIDENCE_EXPIRY_MS) {
      ledger[entry.key] = resolveEntry(entry, 'VOID', nowMs, { reason: 'evidence_expired' });
      counts.void += 1;
    } else {
      resolvable.push(entry);
    }
  }
  if (resolvable.length === 0) return resolution(ledger, counts, false);

  const archived = await archive.readStories(Math.min(...resolvable.map((entry) => entry.emittedAt)));
  if (!Array.isArray(archived?.stories)) return resolution(ledger, counts, true);
  const { coveredFromMs, stories } = archived;
  const proven = resolvable.filter((entry) => coveredFromMs != null && entry.emittedAt >= coveredFromMs);
  counts.unproven = resolvable.length - proven.length;

  const entityMatchCache = new Map();
  const entityMatchesFor = (title) => {
    if (!entityMatchCache.has(title)) entityMatchCache.set(title, findEntitiesInText(title));
    return entityMatchCache.get(title);
  };
  const candidatesByKey = new Map();
  for (const entry of proven) {
    const candidates = stories
      .filter((story) => story.firstSeen >= entry.emittedAt && story.firstSeen <= entry.deadline)
      .filter((story) => storyMatchesEntity(
        story.title,
        entry.entity,
        entry.entity.kind === 'market' && entry.entity.entityId ? entityMatchesFor(story.title) : undefined,
      ))
      .sort((a, b) => a.firstSeen - b.firstSeen);
    candidatesByKey.set(entry.key, candidates);
  }

  const hashes = [...new Set([...candidatesByKey.values()].flat().map((story) => story.hash))];
  const sourceTierByHash = hashes.length > 0 ? await archive.readSourceTiers(hashes) : new Map();
  if (!(sourceTierByHash instanceof Map)) return resolution(ledger, counts, true);

  for (const entry of proven) {
    const candidates = candidatesByKey.get(entry.key);
    const evidence = candidates.find((story) => (sourceTierByHash.get(story.hash)?.tier ?? 4) <= MARKET_ALERT_HIT_MAX_TIER);
    if (evidence) {
      const { tier, source } = sourceTierByHash.get(evidence.hash);
      ledger[entry.key] = resolveEntry(entry, 'HIT', nowMs, {
        storyHash: evidence.hash,
        title: evidence.title,
        source,
        tier,
        firstSeen: evidence.firstSeen,
        leadTimeMs: evidence.firstSeen - entry.emittedAt,
      });
      counts.hit += 1;
    } else {
      ledger[entry.key] = resolveEntry(entry, 'MISS', nowMs, { reason: 'no_matching_story', candidates: candidates.length });
      counts.miss += 1;
    }
  }
  return resolution(ledger, counts, false);
}

export function pruneLedger(ledger, nowMs) {
  const cutoff = nowMs - MARKET_ALERT_LEDGER_RETENTION_MS;
  return Object.fromEntries(Object.entries(ledger).filter(([, entry]) => entry.status !== 'resolved' || entry.resolvedAt >= cutoff));
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function buildScorecard(ledger, nowMs) {
  const entries = Object.values(ledger);
  const since = nowMs - MARKET_ALERT_LEDGER_RETENTION_MS;
  const scored = entries.filter((entry) => entry.status === 'resolved' && entry.resolvedAt >= since);
  const rowFor = (type) => {
    const pending = entries.filter((entry) => entry.status === 'pending' && (type === null || entry.type === type)).length;
    const resolved = scored.filter((entry) => type === null || entry.type === type);
    const count = (outcome) => resolved.filter((entry) => entry.outcome === outcome).length;
    const hit = count('HIT');
    const miss = count('MISS');
    return {
      pending,
      resolved: resolved.length,
      hit,
      miss,
      void: count('VOID'),
      n: hit + miss,
      hitRate: hit + miss > 0 ? hit / (hit + miss) : null,
      medianLeadTimeMs: median(resolved.filter((entry) => entry.outcome === 'HIT').map((entry) => entry.evidence.leadTimeMs)),
    };
  };
  const totals = rowFor(null);
  return {
    schemaVersion: 1,
    generatedAt: nowMs,
    windowHours: MARKET_ALERT_WINDOW_MS / HOUR_MS,
    rollingWindowDays: MARKET_ALERT_ROLLING_WINDOW_DAYS,
    methodology: MARKET_ALERT_RESOLUTION_RULE,
    totals: { entries: entries.length, pending: totals.pending, resolved: totals.resolved, hit: totals.hit, miss: totals.miss, void: totals.void },
    byType: MARKET_ALERT_TYPES.map((type) => ({ type, ...rowFor(type) })),
  };
}
