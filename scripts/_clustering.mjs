#!/usr/bin/env node

const SIMILARITY_THRESHOLD = 0.5;

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

const FLASHPOINT_KEYWORDS = [
  'iran', 'tehran', 'russia', 'moscow', 'china', 'beijing', 'taiwan', 'ukraine', 'kyiv',
  'north korea', 'pyongyang', 'israel', 'gaza', 'west bank', 'syria', 'damascus',
  'yemen', 'hezbollah', 'hamas', 'kremlin', 'pentagon', 'nato', 'wagner',
];

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
      const tierDiff = (a.tier ?? 99) - (b.tier ?? 99);
      if (tierDiff !== 0) return tierDiff;
      return new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime();
    });

    const primary = sorted[0];
    // Prefer highest-tier non-keyword threat; `sorted` is already tier/date ordered so reuse it.
    const threatItem = sorted.find(i => i.threat?.level && i.threat?.source !== 'keyword');
    return {
      primaryTitle: primary.title,
      primarySource: primary.source,
      primaryLink: primary.link,
      pubDate: primary.pubDate,
      sourceCount: group.length,
      isAlert: group.some(i => i.isAlert),
      threat: threatItem?.threat ? { ...threatItem.threat } : (primary.threat ? { ...primary.threat } : undefined),
    };
  });
}

function countMatches(text, keywords) {
  return keywords.filter(kw => text.includes(kw)).length;
}

export function scoreImportance(cluster) {
  let score = 0;
  const titleLower = (cluster.primaryTitle || '').toLowerCase();

  score += (cluster.sourceCount || 1) * 10;

  const violenceN = countMatches(titleLower, VIOLENCE_KEYWORDS);
  if (violenceN > 0) score += 100 + violenceN * 25;

  const militaryN = countMatches(titleLower, MILITARY_KEYWORDS);
  if (militaryN > 0) score += 80 + militaryN * 20;

  const unrestN = countMatches(titleLower, UNREST_KEYWORDS);
  if (unrestN > 0) score += 70 + unrestN * 18;

  const flashpointN = countMatches(titleLower, FLASHPOINT_KEYWORDS);
  if (flashpointN > 0) score += 60 + flashpointN * 15;

  if ((violenceN > 0 || unrestN > 0) && flashpointN > 0) {
    score *= 1.5;
  }

  const crisisN = countMatches(titleLower, CRISIS_KEYWORDS);
  if (crisisN > 0) score += 30 + crisisN * 10;

  const demoteN = countMatches(titleLower, DEMOTE_KEYWORDS);
  if (demoteN > 0) score *= 0.3;

  if (cluster.isAlert) score += 50;

  return score;
}

// Note: velocity filter omitted (vs frontend selectTopStories) because digest
// items lack velocity data. Phase B may add velocity when RPC provides it.
export function selectTopStories(clusters, maxCount = 8) {
  const scored = clusters
    .map(c => ({ cluster: c, score: scoreImportance(c) }))
    .filter(({ cluster: c, score }) =>
      (c.sourceCount || 1) >= 2 ||
      c.isAlert ||
      score > 100
    )
    .sort((a, b) => b.score - a.score);

  const selected = [];
  const sourceCount = new Map();
  const MAX_PER_SOURCE = 3;

  for (const { cluster, score } of scored) {
    const source = cluster.primarySource;
    const count = sourceCount.get(source) || 0;
    if (count < MAX_PER_SOURCE) {
      selected.push({ ...cluster, importanceScore: score });
      sourceCount.set(source, count + 1);
    }
    if (selected.length >= maxCount) break;
  }

  return selected;
}
