#!/usr/bin/env node

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SOURCE_TIERS = require('./shared/source-tiers.json');
// scripts/shared/ mirror (NOT ../shared/): seed-insights.mjs deploys via
// nixpacks with rootDirectory=scripts, so the repo-root shared/ folder
// is not in the container. Matches the SOURCE_TIERS pattern above.
const DIPLOMACY_KEYWORDS_DATA = require('./shared/diplomacy-keywords.json');

const SIMILARITY_THRESHOLD = 0.5;
const ENTITY_CORROBORATION_WINDOW_MS = 24 * 60 * 60 * 1000;

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
  'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he',
  'she', 'we', 'they', 'what', 'which', 'who', 'whom', 'how', 'when',
  'where', 'why', 'all', 'each', 'every', 'both', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'not', 'only', 'same', 'so', 'than',
  'too', 'very', 'just', 'also', 'now', 'new', 'says', 'said', 'after',
]);

const MILITARY_KEYWORDS = [
  'war', 'armada', 'invasion', 'airstrike', 'strike', 'missile', 'troops',
  'deployed', 'offensive', 'artillery', 'bomb', 'combat', 'fleet', 'warship',
  'carrier', 'navy', 'airforce', 'deployment', 'mobilization', 'attack',
];

const VIOLENCE_KEYWORDS = [
  'killed', 'dead', 'death', 'shot', 'blood', 'massacre', 'slaughter',
  'fatalities', 'casualties', 'wounded', 'injured', 'murdered', 'execution',
  'crackdown', 'violent', 'clashes', 'gunfire', 'shooting',
];

const UNREST_KEYWORDS = [
  'protest', 'protests', 'uprising', 'revolt', 'revolution', 'riot', 'riots',
  'demonstration', 'unrest', 'dissent', 'rebellion', 'insurgent', 'overthrow',
  'coup', 'martial law', 'curfew', 'shutdown', 'blackout',
];

const FLASHPOINT_KEYWORDS = DIPLOMACY_KEYWORDS_DATA.flashpointKeywords;
export const DIPLOMACY_KEYWORDS = DIPLOMACY_KEYWORDS_DATA.diplomacyKeywords;
export const ENTITY_BIGRAMS = DIPLOMACY_KEYWORDS_DATA.diplomacyFlashpointPairs;

const CRISIS_KEYWORDS = [
  'crisis', 'emergency', 'catastrophe', 'disaster', 'collapse', 'humanitarian',
  'sanctions', 'ultimatum', 'threat', 'retaliation', 'escalation', 'tensions',
  'breaking', 'urgent', 'developing', 'exclusive',
];

const DEMOTE_KEYWORDS = [
  'ceo', 'earnings', 'stock', 'startup', 'data center', 'datacenter', 'revenue',
  'quarterly', 'profit', 'investor', 'ipo', 'funding', 'valuation',
];

function tokenize(text) {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  return new Set(words);
}

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toFiniteMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

function getItemPubMs(item) {
  if (item?.pubDateMissing === true) return 0;
  return toFiniteMs(item?.pubDate ?? item?.publishedAt ?? item?.date);
}

function normalizeSourceName(source) {
  return typeof source === 'string' ? source.trim() : '';
}

function sourceTierFor(source) {
  const tier = SOURCE_TIERS[source];
  return Number.isFinite(tier) ? tier : 4;
}

function sourceTierForSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return 4;
  return Math.min(...sources.map(sourceTierFor));
}

function normalizeThreatLevel(level) {
  if (typeof level !== 'string') return '';
  const upper = level.toUpperCase();
  if (upper.startsWith('THREAT_LEVEL_')) {
    const suffix = upper.slice('THREAT_LEVEL_'.length).toLowerCase();
    return suffix === 'unspecified' ? 'info' : suffix;
  }
  return level.toLowerCase();
}

function isLlmThreatSource(source) {
  return source === 'llm';
}

function normalizedMatchText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Word-start containment in normalizedMatchText output. Mirrors
// shared/brief-filter.js:containsKeywordToken — prevents 'pact' inside
// 'impact' (false positive) while still matching 'iran' inside
// 'iranian' (demonym preserved). PR #3909 review (P2).
function containsKeywordToken(text, kw) {
  if (!kw) return false;
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}`).test(text);
}

function jaccardSimilarity(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) {
    if (b.has(x)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return intersection / union;
}

export function clusterItems(items) {
  if (items.length === 0) return [];

  const tokenList = items.map(item => tokenize(item.title || ''));

  const invertedIndex = new Map();
  for (let i = 0; i < tokenList.length; i++) {
    for (const token of tokenList[i]) {
      const bucket = invertedIndex.get(token);
      if (bucket) bucket.push(i);
      else invertedIndex.set(token, [i]);
    }
  }

  const clusters = [];
  const assigned = new Set();

  for (let i = 0; i < items.length; i++) {
    if (assigned.has(i)) continue;

    const cluster = [i];
    assigned.add(i);
    const tokensI = tokenList[i];

    const candidates = new Set();
    for (const token of tokensI) {
      const bucket = invertedIndex.get(token);
      if (!bucket) continue;
      for (const idx of bucket) {
        if (idx > i) candidates.add(idx);
      }
    }

    for (const j of Array.from(candidates).sort((a, b) => a - b)) {
      if (assigned.has(j)) continue;
      if (jaccardSimilarity(tokensI, tokenList[j]) >= SIMILARITY_THRESHOLD) {
        cluster.push(j);
        assigned.add(j);
      }
    }

    clusters.push(cluster.map(idx => items[idx]));
  }

  return clusters.map(group => {
    const sorted = [...group].sort((a, b) => {
      const tierA = finiteNumber(a.tier, sourceTierFor(a.source));
      const tierB = finiteNumber(b.tier, sourceTierFor(b.source));
      const tierDiff = tierA - tierB;
      if (tierDiff !== 0) return tierDiff;
      return getItemPubMs(b) - getItemPubMs(a);
    });

    const primary = sorted[0];
    const sources = [...new Set(group.map(i => normalizeSourceName(i.source)).filter(Boolean))]
      .sort((a, b) => sourceTierFor(a) - sourceTierFor(b) || a.localeCompare(b));
    const sourceTier = sourceTierForSources(sources);
    const publishedTimes = group.map(getItemPubMs).filter(ms => ms > 0);
    const lastUpdatedMs = publishedTimes.length > 0 ? Math.max(...publishedTimes) : getItemPubMs(primary);
    const upstreamImportanceScore = group.reduce(
      (max, item) => Math.max(max, finiteNumber(item.importanceScore, 0)),
      0,
    );
    const corroborationCount = group.reduce((max, item) => {
      const itemCount = finiteNumber(item.corroborationCount ?? item.storyMeta?.sourceCount, 0);
      return Math.max(max, itemCount);
    }, 0);
    const threatItem = sorted.find(i => i.threat?.level && isLlmThreatSource(i.threat?.source));
    return {
      primaryTitle: primary.title,
      primarySource: primary.source,
      primaryLink: primary.link,
      pubDate: primary.pubDate,
      sourceCount: group.length,
      sources,
      lastUpdated: lastUpdatedMs > 0 ? new Date(lastUpdatedMs).toISOString() : primary.pubDate,
      memberTitles: group.map(i => i.title).filter(Boolean),
      sourceTier,
      upstreamImportanceScore,
      corroborationCount,
      isAlert: group.some(i => i.isAlert),
      threat: threatItem?.threat ? { ...threatItem.threat } : (primary.threat ? { ...primary.threat } : undefined),
    };
  });
}

function countMatches(text, keywords) {
  return keywords.filter(kw => text.includes(kw)).length;
}

function publisherCount(cluster) {
  return Math.max(
    Array.isArray(cluster.sources) ? cluster.sources.length : 0,
    finiteNumber(cluster.corroborationSourceCount, 0),
    finiteNumber(cluster.corroborationCount, 0),
    1,
  );
}

function hasStrongNonKeywordSignal(cluster) {
  const level = normalizeThreatLevel(cluster.threat?.level);
  return isLlmThreatSource(cluster.threat?.source) && (level === 'high' || level === 'critical');
}

export function scoreImportance(cluster) {
  let score = 0;
  const titleLower = normalizedMatchText(cluster.primaryTitle);
  const upstream = finiteNumber(cluster.upstreamImportanceScore, 0);
  if (upstream > 0) score += upstream * 2.2;

  const level = normalizeThreatLevel(cluster.threat?.level);
  const threatScores = { critical: 220, high: 150, medium: 80, low: 20, info: 0 };
  if (level && isLlmThreatSource(cluster.threat?.source)) {
    score += threatScores[level] ?? 0;
  } else if (level && upstream > 0 && cluster.threat?.source !== 'keyword-historical-downgrade') {
    score += (threatScores[level] ?? 0) * 0.35;
  }

  const sourceTier = finiteNumber(cluster.sourceTier, sourceTierFor(cluster.primarySource));
  score += sourceTier === 1 ? 35 : sourceTier === 2 ? 20 : sourceTier === 3 ? 8 : 0;

  const sourcesN = publisherCount(cluster);
  score += Math.min(sourcesN, 6) * 12;
  if (cluster.entityCorroboration) score += 45;

  const violenceN = countMatches(titleLower, VIOLENCE_KEYWORDS);
  if (violenceN > 0) score += 50 + violenceN * 12;

  const militaryN = countMatches(titleLower, MILITARY_KEYWORDS);
  if (militaryN > 0) score += 40 + militaryN * 10;

  const unrestN = countMatches(titleLower, UNREST_KEYWORDS);
  if (unrestN > 0) score += 35 + unrestN * 9;

  const flashpointN = countMatches(titleLower, FLASHPOINT_KEYWORDS);
  if (flashpointN > 0) score += 30 + flashpointN * 8;

  const diplomacyN = countMatches(titleLower, DIPLOMACY_KEYWORDS);
  if (diplomacyN > 0) score += 35 + diplomacyN * 9;
  if ((violenceN > 0 || unrestN > 0 || diplomacyN > 0) && flashpointN > 0) score *= 1.25;

  const crisisN = countMatches(titleLower, CRISIS_KEYWORDS);
  if (crisisN > 0) score += 15 + crisisN * 5;

  const demoteN = countMatches(titleLower, DEMOTE_KEYWORDS);
  if (demoteN > 0 && !cluster.entityCorroboration && !hasStrongNonKeywordSignal(cluster)) score *= 0.35;

  return score;
}

export function recencyWeight(cluster, nowMs = Date.now()) {
  const updatedMs = toFiniteMs(cluster?.lastUpdated ?? cluster?.pubDate);
  if (updatedMs <= 0) return 1;
  const ageHours = Math.max(0, (nowMs - updatedMs) / 3600000);
  return Math.max(0.5, 1 - ageHours / 16);
}

export function isBriefLeadEligible(cluster) {
  const uniqueSources = Array.isArray(cluster?.sources)
    ? cluster.sources.filter(s => typeof s === 'string' && s.trim().length > 0).length
    : 0;
  return uniqueSources >= 2 || cluster?.entityCorroboration === true;
}

export function isTopStoriesAdmissible(cluster, score) {
  return isBriefLeadEligible(cluster) || cluster?.isAlert === true || score > 100;
}

function entityKeysForCluster(cluster) {
  const titles = Array.isArray(cluster.memberTitles) && cluster.memberTitles.length > 0
    ? cluster.memberTitles
    : [cluster.primaryTitle];
  const keys = new Set();
  for (const title of titles) {
    const text = normalizedMatchText(title);
    for (const [entity, action] of ENTITY_BIGRAMS) {
      if (containsKeywordToken(text, entity) && containsKeywordToken(text, action)) {
        keys.add(`${entity}:${action}`);
      }
    }
  }
  return keys;
}

export function computeEntityCorroboration(clusters, nowMs = Date.now()) {
  if (!Array.isArray(clusters) || clusters.length === 0) return clusters;
  const buckets = new Map();
  for (const cluster of clusters) {
    cluster.entityCorroboration = false;
    cluster.corroborationSourceCount = 0;
    const updatedMs = toFiniteMs(cluster.lastUpdated ?? cluster.pubDate);
    if (updatedMs <= 0 || nowMs - updatedMs > ENTITY_CORROBORATION_WINDOW_MS) continue;
    for (const key of entityKeysForCluster(cluster)) {
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { clusters: [], sources: new Set() };
        buckets.set(key, bucket);
      }
      bucket.clusters.push(cluster);
      for (const source of cluster.sources ?? []) {
        const normalized = normalizeSourceName(source);
        if (normalized) bucket.sources.add(normalized);
      }
    }
  }

  for (const bucket of buckets.values()) {
    if (bucket.sources.size < 2) continue;
    for (const cluster of bucket.clusters) {
      cluster.entityCorroboration = true;
      cluster.corroborationSourceCount = Math.max(
        finiteNumber(cluster.corroborationSourceCount, 0),
        bucket.sources.size,
      );
    }
  }
  return clusters;
}

// Note: velocity filter omitted (vs frontend selectTopStories) because digest
// items lack velocity data. Phase B may add velocity when RPC provides it.
export function selectTopStories(clusters, maxCount = 8) {
  const nowMs = Date.now();
  computeEntityCorroboration(clusters, nowMs);
  const scored = clusters
    .map(c => {
      const score = scoreImportance(c);
      return { cluster: c, score, effectiveScore: score * recencyWeight(c, nowMs) };
    })
    .filter(({ cluster: c, score }) => isTopStoriesAdmissible(c, score))
    .sort((a, b) => b.effectiveScore - a.effectiveScore || b.score - a.score);

  const selected = [];
  const sourceCount = new Map();
  const MAX_PER_SOURCE = 3;

  for (const { cluster, score, effectiveScore } of scored) {
    const source = cluster.primarySource;
    const count = sourceCount.get(source) || 0;
    if (count < MAX_PER_SOURCE) {
      selected.push({ ...cluster, importanceScore: score, effectiveImportanceScore: effectiveScore });
      sourceCount.set(source, count + 1);
    }
    if (selected.length >= maxCount) break;
  }

  return selected;
}
