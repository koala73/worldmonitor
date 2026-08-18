/**
 * Keyword/CVE/APT spike primitives — single implementation shared by the
 * client trending-keywords engine (src/services/trending-keywords.ts imports
 * from here) and the server-side get_keyword_spikes MCP tool (issue #5697).
 *
 * Ported verbatim from src/services/trending-keywords.ts: the regex entity
 * extractors, term candidacy, display normalization, proper-noun heuristic,
 * and the spike decision math. The client keeps its stateful machinery
 * (rolling term records, cooldowns, localStorage config, ML enrichment);
 * the server computes the same decision over a story corpus snapshot via
 * computeKeywordSpikesFromStories.
 *
 * ESM, no dependencies beyond ./text-analysis-core.js. Types in
 * keyword-spike-core.d.ts.
 */

import { SUPPRESSED_TRENDING_TERMS, escapeRegex, tokenize } from './text-analysis-core.js';
// #6428: spike "source diversity" counts publishers, not feed labels.
import { PUBLISHER_FAMILIES, publisherFamilyFor } from './publisher-families.js';

export const CVE_PATTERN = /CVE-\d{4}-\d{4,}/gi;
export const APT_PATTERN = /APT\d+/gi;
export const FIN_PATTERN = /FIN\d+/gi;

export const LEADER_NAMES = [
  'putin', 'zelensky', 'xi jinping', 'biden', 'trump', 'netanyahu',
  'khamenei', 'erdogan', 'modi', 'macron', 'scholz', 'starmer',
  'orban', 'milei', 'kim jong un', 'al-sisi',
];
export const LEADER_PATTERNS = LEADER_NAMES.map(name => ({
  name,
  pattern: new RegExp(`\\b${escapeRegex(name)}\\b`, 'i'),
}));

export const ROLLING_WINDOW_MS = 2 * 60 * 60 * 1000;
export const BASELINE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_TOKEN_LENGTH = 3;
export const MIN_SPIKE_SOURCE_COUNT = 2;
export const DEFAULT_MIN_SPIKE_COUNT = 5;
export const DEFAULT_SPIKE_MULTIPLIER = 3;

export function toTermKey(term) {
  return term.trim().toLowerCase();
}

export function asDisplayTerm(term) {
  if (/^(cve-\d{4}-\d{4,}|apt\d+|fin\d+)$/i.test(term)) {
    return term.toUpperCase();
  }
  return term.toLowerCase();
}

/** True when the term is one of the always-significant entity shapes. */
export function isEntityShapedTerm(term) {
  if (/^(cve-\d{4}-\d{4,}|apt\d+|fin\d+)$/i.test(term)) return true;
  return LEADER_PATTERNS.some(({ pattern }) => pattern.test(term));
}

export function extractEntities(text) {
  const entities = [];
  const lower = text.toLowerCase();

  for (const match of text.matchAll(CVE_PATTERN)) {
    entities.push(match[0].toUpperCase());
  }
  for (const match of text.matchAll(APT_PATTERN)) {
    entities.push(match[0].toUpperCase());
  }
  for (const match of text.matchAll(FIN_PATTERN)) {
    entities.push(match[0].toUpperCase());
  }
  for (const { name, pattern } of LEADER_PATTERNS) {
    if (pattern.test(lower)) {
      entities.push(name);
    }
  }

  return entities;
}

export function stripSourceAttribution(title) {
  const idx = title.lastIndexOf(' - ');
  if (idx === -1) return title;
  const after = title.slice(idx + 3).trim();
  if (after.length > 0 && after.length <= 60 && !/[.!?]/.test(after)) {
    return title.slice(0, idx).trim();
  }
  return title;
}

export function buildBaseTermCandidates(title) {
  const termCandidates = new Map();
  const cleanTitle = stripSourceAttribution(title);

  for (const token of tokenize(cleanTitle)) {
    const termKey = toTermKey(token);
    termCandidates.set(termKey, { display: token, isEntity: false });
  }

  for (const entity of extractEntities(cleanTitle)) {
    const termKey = toTermKey(entity);
    termCandidates.set(termKey, { display: entity, isEntity: true });
  }

  return termCandidates;
}

export function isLikelyProperNoun(term, headlines) {
  if (term.includes(' ') && term.length > 5) return true;
  if (/^\d/.test(term)) return true;

  const titles = headlines.slice(0, 8).map(h => h.title);
  const termRe = new RegExp(`\\b${escapeRegex(term)}\\b`, 'gi');
  let capitalizedCount = 0;
  let midSentenceCount = 0;
  for (const title of titles) {
    for (const m of title.matchAll(termRe)) {
      const idx = m.index ?? 0;
      if (idx === 0) continue;
      midSentenceCount++;
      if (/[A-Z]/.test(title[idx])) capitalizedCount++;
    }
  }
  if (midSentenceCount === 0) {
    return titles.some(t => {
      const allCaps = t.match(new RegExp(`\\b${escapeRegex(term)}\\b`, 'gi'));
      return allCaps?.some(match => match === match.toUpperCase() && match.length >= 2);
    });
  }
  return capitalizedCount / midSentenceCount >= 0.5;
}

/**
 * The spike decision math from trending-keywords checkForSpikes, extracted so
 * client and server cannot drift. Callers gate on source diversity
 * (MIN_SPIKE_SOURCE_COUNT) and any cooldown themselves.
 */
export function evaluateSpikeDecision({ recentCount, baseline, minSpikeCount, spikeMultiplier }) {
  if (recentCount < minSpikeCount) return { isSpike: false, multiplier: 0 };
  const multiplier = baseline > 0 ? recentCount / baseline : 0;
  const isSpike = baseline > 0
    ? recentCount > baseline * spikeMultiplier
    : recentCount >= minSpikeCount;
  return { isSpike, multiplier };
}

/**
 * Corpus-snapshot spike computation for the server-side tool: applies the
 * shared candidacy + decision math over stories with known last-seen times.
 * `baseline` is the per-window story rate over the exact sampled pre-window
 * duration — the digest accumulator server-side, vs the client's incremental
 * 7-day per-term history. Same decision function either way. A caller with no
 * sampled pre-window duration has no defensible baseline, so no spikes emit.
 *
 * stories: Array<{ title, lastSeenMs, sources?: string[], link?: string }>
 */

function displayNameForLabel(label) {
  const family = publisherFamilyFor(label);
  if (!family) return '';
  return PUBLISHER_FAMILIES[family]?.publisher ?? String(label).trim();
}

function collectPublisherNames(stories) {
  const byFamily = new Map();
  for (const story of stories) {
    if (!Array.isArray(story.sources)) continue;
    for (const label of story.sources) {
      const family = publisherFamilyFor(label);
      if (!family || byFamily.has(family)) continue;
      byFamily.set(family, displayNameForLabel(label));
    }
  }
  return {
    uniqueSources: byFamily.size,
    sourceNames: [...byFamily.values()].sort((a, b) => a.localeCompare(b)),
  };
}

function sampleHeadlineFromStory(story) {
  const names = collectPublisherNames([story]).sourceNames;
  return {
    title: story.title,
    source: names.join(', '),
    link: typeof story.link === 'string' ? story.link : '',
  };
}

export function computeKeywordSpikesFromStories(stories, {
  nowMs,
  windowMs = ROLLING_WINDOW_MS,
  baselineDurationMs,
  minSpikeCount = DEFAULT_MIN_SPIKE_COUNT,
  spikeMultiplier = DEFAULT_SPIKE_MULTIPLIER,
  blockedTerms = SUPPRESSED_TRENDING_TERMS,
  maxSampleHeadlines = 3,
}) {
  if (!Number.isFinite(baselineDurationMs) || baselineDurationMs <= 0) return [];

  const windowStart = nowMs - windowMs;
  const baselineWindows = baselineDurationMs / windowMs;

  const terms = new Map();
  for (const story of stories) {
    if (!story?.title || !Number.isFinite(story.lastSeenMs)) continue;
    const isRecent = story.lastSeenMs >= windowStart && story.lastSeenMs <= nowMs;
    for (const [termKey, meta] of buildBaseTermCandidates(story.title)) {
      if (blockedTerms.has(termKey)) continue;
      if (!meta.isEntity && termKey.length < MIN_TOKEN_LENGTH) continue;

      let record = terms.get(termKey);
      if (!record) {
        record = { display: asDisplayTerm(meta.display), recent: [], baselineCount: 0 };
        terms.set(termKey, record);
      } else if (meta.isEntity) {
        record.display = asDisplayTerm(meta.display);
      }
      if (isRecent) record.recent.push(story);
      else record.baselineCount += 1;
    }
  }

  const spikes = [];
  for (const record of terms.values()) {
    const recentCount = record.recent.length;
    const baseline = record.baselineCount / baselineWindows;
    const { isSpike, multiplier } = evaluateSpikeDecision({
      recentCount, baseline, minSpikeCount, spikeMultiplier,
    });
    if (!isSpike) continue;

    // #6428: source diversity is a claim about PUBLISHERS. story.sources holds
    // the raw feed labels persisted to story:sources:v1, so a single newsroom
    // shipping the term through several of its own feeds used to clear this
    // gate alone — and `uniqueSources` is surfaced to agents by
    // get_keyword_spikes as the diversity evidence for the alert.
    const publishers = collectPublisherNames(record.recent);
    if (publishers.uniqueSources < MIN_SPIKE_SOURCE_COUNT) continue;

    spikes.push({
      term: record.display,
      count: recentCount,
      baseline,
      multiplier,
      windowMs,
      uniqueSources: publishers.uniqueSources,
      sourceNames: publishers.sourceNames,
      sampleHeadlines: (record.recent.some((story) => collectPublisherNames([story]).uniqueSources > 0)
        ? record.recent.filter((story) => collectPublisherNames([story]).uniqueSources > 0)
        : record.recent
      ).slice(0, maxSampleHeadlines).map(sampleHeadlineFromStory),
    });
  }

  return spikes.sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
}
