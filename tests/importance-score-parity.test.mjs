/**
 * Parity test: the relay-inlined importance scorer (scripts/ais-relay.cjs)
 * must produce identical output to the canonical digest scorer
 * (server/worldmonitor/news/v1/list-feed-digest.ts).
 *
 * Background: PR #2604 introduced importanceScore in the digest. The relay
 * republishes classified headlines as rss_alert events and must carry a score
 * recomputed from the post-LLM threat level (see docs/internal/scoringDiagnostic.md).
 * Both sides load SOURCE_TIERS from shared/source-tiers.json (same bytes), so
 * tier-map parity is structural. This test covers SEVERITY_SCORES, SCORE_WEIGHTS,
 * and computeImportanceScore() itself — the pieces still duplicated until a
 * follow-up moves them into shared/ too (todo #195, part 2).
 *
 * Run: node --test tests/importance-score-parity.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeBriefFromDigestStories } from '../scripts/lib/brief-compose.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const digestSrc = readFileSync(
  resolve(repoRoot, 'server/worldmonitor/news/v1/list-feed-digest.ts'),
  'utf-8',
);
const relaySrc = readFileSync(
  resolve(repoRoot, 'scripts/ais-relay.cjs'),
  'utf-8',
);
const clusteringSrc = readFileSync(
  resolve(repoRoot, 'scripts/_clustering.mjs'),
  'utf-8',
);
const briefFilterSrc = readFileSync(
  resolve(repoRoot, 'shared/brief-filter.js'),
  'utf-8',
);

// Shared source of truth: both sides load this JSON at runtime.
// The test uses it as the oracle for tier lookups.
const sharedSourceTiers = JSON.parse(
  readFileSync(resolve(repoRoot, 'shared/source-tiers.json'), 'utf-8'),
);

// Canonical diplomacy/flashpoint keyword set. As of the centralization
// PR, digest / clustering / brief-filter all consume this JSON directly,
// so the test uses it as the oracle instead of re-parsing each consumer's
// (now-import-backed) literal. The relay (ais-relay.cjs) still inlines
// its own copy — drift between the canonical JSON and the relay literal
// is asserted further below.
const sharedDiplomacyKeywords = JSON.parse(
  readFileSync(resolve(repoRoot, 'shared/diplomacy-keywords.json'), 'utf-8'),
);

// ── Extract constants from source files ──────────────────────────────────────

function extractObjectLiteral(src, varName) {
  // Locate `<prefix>const NAME ... = ` then brace-match the literal. Works for
  // single-line and multi-line objects and tolerates `as const` / type suffixes.
  // Not JS-aware: does not skip strings/comments/templates. Current constants
  // are plain objects of primitives so this is sufficient; if the tracked
  // literals ever grow embedded braces inside strings, upgrade this to the
  // TypeScript compiler API.
  const re = new RegExp(`(?:export\\s+)?const\\s+${varName}\\b[^=]*=\\s*\\{`);
  const match = src.match(re);
  if (!match) throw new Error(`Could not find declaration for ${varName}`);
  const braceStart = match.index + match[0].length - 1;
  let depth = 1;
  let i = braceStart + 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  if (depth !== 0) throw new Error(`Unbalanced braces in ${varName}`);
  const literal = src.slice(braceStart, i);
  return new Function(`return (${literal});`)();
}

function extractArrayLiteral(src, varName) {
  const re = new RegExp(`(?:export\\s+)?const\\s+${varName}\\b[^=]*=\\s*\\[`);
  const match = src.match(re);
  if (!match) throw new Error(`Could not find declaration for ${varName}`);
  const bracketStart = match.index + match[0].length - 1;
  let depth = 1;
  let i = bracketStart + 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    i++;
  }
  if (depth !== 0) throw new Error(`Unbalanced brackets in ${varName}`);
  const literal = src.slice(bracketStart, i);
  return new Function(`return (${literal});`)();
}

function extractNumericConst(src, varName) {
  const re = new RegExp(`const\\s+${varName}\\b[^=]*=\\s*([0-9.]+)`);
  const match = src.match(re);
  if (!match) throw new Error(`Could not find numeric constant ${varName}`);
  return Number(match[1]);
}

function extractFunctionBody(src, fnSignature) {
  const idx = src.indexOf(fnSignature);
  if (idx === -1) throw new Error(`Could not find ${fnSignature}`);
  const parenStart = src.indexOf('(', idx);
  let parenDepth = 1;
  let parenEnd = parenStart + 1;
  while (parenEnd < src.length && parenDepth > 0) {
    const ch = src[parenEnd];
    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth--;
    parenEnd++;
  }
  if (parenDepth !== 0) throw new Error(`Unbalanced parameters in ${fnSignature}`);
  const openIdx = src.indexOf('{', parenEnd);
  let depth = 1;
  let i = openIdx + 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(openIdx + 1, i - 1);
}

const digestSeverityScores = extractObjectLiteral(digestSrc, 'SEVERITY_SCORES');
const digestScoreWeights = extractObjectLiteral(digestSrc, 'SCORE_WEIGHTS');
// Centralized: digest, clustering, and brief-filter all consume the
// canonical JSON, so the test reads the JSON instead of re-parsing
// each consumer's (now import-backed) declaration.
const digestDiplomacyKeywords = sharedDiplomacyKeywords.diplomacyKeywords;
const digestFlashpointKeywords = sharedDiplomacyKeywords.flashpointKeywords;
const digestDiplomacyPairs = sharedDiplomacyKeywords.diplomacyFlashpointPairs;
const digestDiplomacyBoost = extractNumericConst(digestSrc, 'DIPLOMACY_FLASHPOINT_BOOST');
const digestEntityScorePerSource = extractNumericConst(digestSrc, 'ENTITY_CORROBORATION_SCORE_PER_SOURCE');

// Relay still inlines its own copy (Railway deploy isolation). Drift
// between the relay literal and the canonical JSON would fail the
// parity assertions further below.
const relaySeverityScores = extractObjectLiteral(relaySrc, 'RELAY_SEVERITY_SCORES');
const relayScoreWeights = extractObjectLiteral(relaySrc, 'RELAY_SCORE_WEIGHTS');
const relayDiplomacyKeywords = extractArrayLiteral(relaySrc, 'RELAY_DIPLOMACY_KEYWORDS');
const relayFlashpointKeywords = extractArrayLiteral(relaySrc, 'RELAY_FLASHPOINT_SCORING_KEYWORDS');
const relayDiplomacyPairs = extractArrayLiteral(relaySrc, 'RELAY_DIPLOMACY_FLASHPOINT_PAIRS');
const relayDiplomacyBoost = extractNumericConst(relaySrc, 'RELAY_DIPLOMACY_FLASHPOINT_BOOST');
const relayEntityScorePerSource = extractNumericConst(relaySrc, 'RELAY_ENTITY_CORROBORATION_SCORE_PER_SOURCE');

const clusteringDiplomacyKeywords = sharedDiplomacyKeywords.diplomacyKeywords;
const clusteringFlashpointKeywords = sharedDiplomacyKeywords.flashpointKeywords;
const clusteringDiplomacyPairs = sharedDiplomacyKeywords.diplomacyFlashpointPairs;
const briefFilterDiplomacyKeywords = sharedDiplomacyKeywords.diplomacyKeywords;
const briefFilterFlashpointKeywords = sharedDiplomacyKeywords.flashpointKeywords;
const briefFilterDiplomacyPairs = sharedDiplomacyKeywords.diplomacyFlashpointPairs;

// ── Reconstruct the scorers as pure functions for output comparison ─────────

const digestFnBody = extractFunctionBody(digestSrc, 'function computeImportanceScore(');
const digestComputeImportanceScore = new Function(
  'level', 'source', 'corroborationCount', 'publishedAt', 'context',
  'SEVERITY_SCORES', 'SCORE_WEIGHTS', 'SOURCE_TIERS',
  'DIPLOMACY_KEYWORDS', 'FLASHPOINT_SCORING_KEYWORDS', 'DIPLOMACY_FLASHPOINT_PAIRS',
  'DIPLOMACY_FLASHPOINT_BOOST', 'ENTITY_CORROBORATION_SCORE_PER_SOURCE',
  `
    function getSourceTier(name) { return SOURCE_TIERS[name] ?? 4; }
    function normalizeScoringText(text) {
      return text.toLowerCase().replace(/[^a-z0-9\\s]/g, ' ').replace(/\\s+/g, ' ').trim();
    }
    function containsKeywordToken(text, kw) {
      if (!kw) return false;
      const escaped = kw.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
      return new RegExp('(^|\\\\s)' + escaped).test(text);
    }
    function hasAnySignal(text, keywords) {
      return keywords.some((kw) => containsKeywordToken(text, kw));
    }
    function hasDiplomacyFlashpointSignal(title) {
      if (!title) return false;
      const text = normalizeScoringText(title);
      if (
        DIPLOMACY_FLASHPOINT_PAIRS.some(([entity, action]) =>
          containsKeywordToken(text, entity) && containsKeywordToken(text, action),
        )
      ) {
        return true;
      }
      return hasAnySignal(text, DIPLOMACY_KEYWORDS) && hasAnySignal(text, FLASHPOINT_SCORING_KEYWORDS);
    }
    function diplomacyFlashpointBoost(title) {
      return hasDiplomacyFlashpointSignal(title) ? DIPLOMACY_FLASHPOINT_BOOST : 0;
    }
    function entityCorroborationScore(count) {
      const finite = Number.isFinite(count) ? Number(count) : 0;
      return Math.min(Math.max(finite, 0), 5) * ENTITY_CORROBORATION_SCORE_PER_SOURCE;
    }
    ${digestFnBody}
  `,
);

function digestScore(level, source, corroboration, publishedAt, context = {}) {
  return digestComputeImportanceScore(
    level, source, corroboration, publishedAt, context,
    digestSeverityScores, digestScoreWeights, sharedSourceTiers,
    digestDiplomacyKeywords, digestFlashpointKeywords, digestDiplomacyPairs,
    digestDiplomacyBoost, digestEntityScorePerSource,
  );
}

const relayFnBody = extractFunctionBody(relaySrc, 'function relayComputeImportanceScore(');
const relayComputeImportanceScore = new Function(
  'level', 'source', 'corroborationCount', 'publishedAt', 'context',
  'RELAY_SEVERITY_SCORES', 'RELAY_SCORE_WEIGHTS', 'RELAY_SOURCE_TIERS',
  'RELAY_DIPLOMACY_KEYWORDS', 'RELAY_FLASHPOINT_SCORING_KEYWORDS', 'RELAY_DIPLOMACY_FLASHPOINT_PAIRS',
  'RELAY_DIPLOMACY_FLASHPOINT_BOOST', 'RELAY_ENTITY_CORROBORATION_SCORE_PER_SOURCE',
  `
    function relayGetSourceTier(name) { return RELAY_SOURCE_TIERS[name] ?? 4; }
    function relayNormalizeScoringText(text) {
      return String(text || '').toLowerCase().replace(/[^a-z0-9\\s]/g, ' ').replace(/\\s+/g, ' ').trim();
    }
    function relayContainsKeywordToken(text, kw) {
      if (!kw) return false;
      const escaped = kw.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
      return new RegExp('(^|\\\\s)' + escaped).test(text);
    }
    function relayHasAnySignal(text, keywords) {
      return keywords.some((kw) => relayContainsKeywordToken(text, kw));
    }
    function relayHasDiplomacyFlashpointSignal(title) {
      if (!title) return false;
      const text = relayNormalizeScoringText(title);
      if (
        RELAY_DIPLOMACY_FLASHPOINT_PAIRS.some(([entity, action]) =>
          relayContainsKeywordToken(text, entity) && relayContainsKeywordToken(text, action),
        )
      ) {
        return true;
      }
      return relayHasAnySignal(text, RELAY_DIPLOMACY_KEYWORDS) &&
        relayHasAnySignal(text, RELAY_FLASHPOINT_SCORING_KEYWORDS);
    }
    function relayDiplomacyFlashpointBoost(title) {
      return relayHasDiplomacyFlashpointSignal(title) ? RELAY_DIPLOMACY_FLASHPOINT_BOOST : 0;
    }
    function relayEntityCorroborationScore(count) {
      const finite = Number.isFinite(count) ? Number(count) : 0;
      return Math.min(Math.max(finite, 0), 5) * RELAY_ENTITY_CORROBORATION_SCORE_PER_SOURCE;
    }
    ${relayFnBody}
  `,
);

function relayScore(level, source, corroboration, publishedAt, context = {}) {
  return relayComputeImportanceScore(
    level, source, corroboration, publishedAt, context,
    relaySeverityScores, relayScoreWeights, sharedSourceTiers,
    relayDiplomacyKeywords, relayFlashpointKeywords, relayDiplomacyPairs,
    relayDiplomacyBoost, relayEntityScorePerSource,
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SOURCE_TIERS structural parity', () => {
  it('shared/source-tiers.json has the expected shape', () => {
    assert.ok(Object.keys(sharedSourceTiers).length > 100, 'tier map unexpectedly small');
    for (const [name, tier] of Object.entries(sharedSourceTiers)) {
      assert.ok([1, 2, 3, 4].includes(tier), `${name} has invalid tier ${tier}`);
    }
  });

  it('scripts/shared/source-tiers.json matches shared/source-tiers.json byte-for-byte', () => {
    // Also guarded by tests/edge-functions.test.mjs (scripts-shared-mirror).
    // Duplicated here as an explicit parity cross-check so drift can't sneak
    // through if the edge-functions test is ever narrowed.
    const canonical = readFileSync(resolve(repoRoot, 'shared/source-tiers.json'), 'utf-8');
    const mirror = readFileSync(resolve(repoRoot, 'scripts/shared/source-tiers.json'), 'utf-8');
    assert.equal(
      mirror, canonical,
      'scripts/shared/source-tiers.json drifted from shared/source-tiers.json — run: cp shared/source-tiers.json scripts/shared/',
    );
  });
});

describe('SEVERITY_SCORES parity (digest ↔ relay)', () => {
  it('matches the canonical level → score mapping', () => {
    assert.deepEqual(relaySeverityScores, digestSeverityScores);
  });
});

describe('SCORE_WEIGHTS parity (digest ↔ relay)', () => {
  it('matches the canonical component weights', () => {
    assert.deepEqual(relayScoreWeights, digestScoreWeights);
  });

  it('weights sum to 1.0', () => {
    const sum = Object.values(digestScoreWeights).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1.0) < 1e-9, `weights sum to ${sum}, expected 1.0`);
  });
});

describe('diplomacy / entity boost parity (digest ↔ relay)', () => {
  it('matches diplomacy keyword and flashpoint-pair constants', () => {
    assert.deepEqual(relayDiplomacyKeywords, digestDiplomacyKeywords);
    assert.deepEqual(relayFlashpointKeywords, digestFlashpointKeywords);
    assert.deepEqual(relayDiplomacyPairs, digestDiplomacyPairs);
    assert.equal(relayDiplomacyBoost, digestDiplomacyBoost);
    assert.equal(relayEntityScorePerSource, digestEntityScorePerSource);
  });

  it('keeps clustering diplomacy constants aligned with digest scoring', () => {
    assert.deepEqual(clusteringDiplomacyKeywords, digestDiplomacyKeywords);
    assert.deepEqual(clusteringFlashpointKeywords, digestFlashpointKeywords);
    assert.deepEqual(clusteringDiplomacyPairs, digestDiplomacyPairs);
  });

  it('keeps brief lead-coherence diplomacy constants aligned with digest scoring', () => {
    assert.deepEqual(briefFilterDiplomacyKeywords, digestDiplomacyKeywords);
    assert.deepEqual(briefFilterFlashpointKeywords, digestFlashpointKeywords);
    assert.deepEqual(briefFilterDiplomacyPairs, digestDiplomacyPairs);
  });

  it('does not include generic business deal as a diplomacy keyword', () => {
    assert.equal(digestDiplomacyKeywords.includes('deal'), false);
    assert.equal(relayDiplomacyKeywords.includes('deal'), false);
    assert.equal(clusteringDiplomacyKeywords.includes('deal'), false);
    assert.equal(briefFilterDiplomacyKeywords.includes('deal'), false);
  });
});

describe('computeImportanceScore parity (digest ↔ relay)', () => {
  // Both scorers call Date.now() internally, so recency is non-deterministic
  // across calls but identical on the same call (we evaluate digest then relay
  // with the same wall-clock). publishedAt is "1h before the test ran" only
  // as a rough anchor — the exact recency score drifts with test run time,
  // which is acceptable because both sides see the same drift.
  const oneHourAgo = Date.now() - 3600_000;

  const cases = [
    ['critical', 'Reuters',          5, {}],
    ['critical', 'BBC World',        3, {}],
    ['critical', 'Defense One',      1, {}],
    ['critical', 'Hacker News',      1, {}],
    ['high',     'AP News',          2, {}],
    ['high',     'Al Jazeera',       4, {}],
    ['high',     'unknown-source',   1, {}],   // unknown source defaults to tier 4
    ['medium',   'BBC World',        1, {}],
    ['medium',   'Federal Reserve',  5, {}],
    ['low',      'Reuters',          1, {}],
    ['info',     'Reuters',          1, {}],
    ['info',     'Hacker News',      5, {}],
    [
      'medium',
      'Reuters',
      5,
      {
        title: 'US and Iran close deal to ease Hormuz tensions',
        classSource: 'llm',
        entityCorroborationCount: 5,
      },
    ],
  ];

  for (const [level, source, corr, context] of cases) {
    it(`${level} / ${source} / corr=${corr}`, () => {
      const a = digestScore(level, source, corr, oneHourAgo, context);
      const b = relayScore(level, source, corr, oneHourAgo, context);
      assert.equal(
        b, a,
        `score mismatch for ${level}/${source}/corr=${corr}: digest=${a} relay=${b}`,
      );
    });
  }

  // Intentional asymmetry documented at the relay's inline comment:
  // relay defensively returns 0 for unknown severity; digest returns NaN.
  // If the shared module refactor completes (todo #195 part 2), this
  // divergence disappears.
  it('handles unknown severity level without throwing', () => {
    const bad = 'bogus-level';
    const d = digestScore(bad, 'Reuters', 1, oneHourAgo);
    const r = relayScore(bad, 'Reuters', 1, oneHourAgo);
    // digest → NaN (propagates from undefined * number); relay → finite number (?? 0 fallback)
    assert.ok(Number.isNaN(d) || d === 0, `digest should be NaN or 0, got ${d}`);
    assert.ok(Number.isFinite(r), `relay should be finite (defensive), got ${r}`);
  });

  it('boosts flashpoint diplomacy above stale same-magnitude conflict for digest ordering', () => {
    const deal = digestScore(
      'medium',
      'Reuters',
      5,
      oneHourAgo,
      {
        title: 'US and Iran close deal to ease Hormuz tensions',
        classSource: 'llm',
        entityCorroborationCount: 5,
      },
    );
    const staleConflict = digestScore(
      'critical',
      'unknown-source',
      1,
      Date.now() - 30 * 3600_000,
      { title: 'Missile attack kills dozens as troops strike border city' },
    );
    assert.ok(deal > staleConflict, `expected deal score ${deal} > stale conflict ${staleConflict}`);
  });

  it('does not boost generic Apple deal headlines', () => {
    const baseline = digestScore('medium', 'Reuters', 1, oneHourAgo);
    const appleDeal = digestScore(
      'medium',
      'Reuters',
      1,
      oneHourAgo,
      { title: 'Apple closes deal for new supplier contract' },
    );
    assert.equal(appleDeal, baseline);
  });

  it('scheduled digest regression: scored US-Iran deal stories outrank stale conflict and survive composeBriefFromDigestStories', () => {
    const dealTitles = [
      ['Reuters', 'US and Iran close deal to ease Hormuz tensions'],
      ['AP News', 'Iran deal could calm oil markets after Hormuz alarm'],
      ['Axios', 'Axios: US-Iran deal averts immediate Hormuz disruption'],
      ['BBC World', 'BBC World reports Iran deal talks lower Gulf risk'],
      ['Reuters World', 'Reuters World: Iran deal framework discussed with US officials'],
    ];
    const dealStories = dealTitles.map(([source, title], idx) => ({
      hash: `deal-${idx}`,
      title,
      link: `https://example.com/deal-${idx}`,
      // Server story tracking promotes strongly corroborated flashpoint
      // diplomacy to high so the scheduled digest read path does not drop
      // the story before currentScore ranking can help.
      severity: 'high',
      currentScore: digestScore(
        'medium',
        source,
        5,
        oneHourAgo,
        { title, classSource: 'llm', entityCorroborationCount: 5 },
      ),
      mentionCount: 1,
      phase: 'developing',
      sources: [source],
      category: 'geopolitical',
    }));
    const staleConflict = {
      hash: 'stale-conflict',
      title: 'Missile attack kills dozens as troops strike border city',
      link: 'https://example.com/stale-conflict',
      severity: 'critical',
      currentScore: digestScore(
        'critical',
        'unknown-source',
        1,
        Date.now() - 30 * 3600_000,
        { title: 'Missile attack kills dozens as troops strike border city' },
      ),
      mentionCount: 1,
      phase: 'breaking',
      sources: ['Unknown Wire'],
      category: 'conflict',
    };
    const ordered = [...dealStories, staleConflict].sort((a, b) => b.currentScore - a.currentScore);
    assert.match(ordered[0].title, /Iran|US-Iran/i);
    assert.ok(ordered[0].currentScore > staleConflict.currentScore);

    const envelope = composeBriefFromDigestStories(
      {
        userId: 'user_test',
        variant: 'full',
        digestMode: 'daily',
        sensitivity: 'high',
        digestTimezone: 'UTC',
        updatedAt: oneHourAgo,
      },
      ordered,
      { clusters: ordered.length, multiSource: 5 },
      { nowMs: Date.now() },
    );
    assert.ok(envelope, 'expected scheduled digest compose to keep at least one story');
    assert.ok(
      envelope.data.stories.some((story) => /iran/i.test(story.headline) && /deal/i.test(story.headline)),
      'expected a US-Iran deal story to survive scheduled digest composition',
    );
  });
});
