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

// Shared source of truth: both sides load this JSON at runtime.
// The test uses it as the oracle for tier lookups.
const sharedSourceTiers = JSON.parse(
  readFileSync(resolve(repoRoot, 'shared/source-tiers.json'), 'utf-8'),
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

function extractFunctionBody(src, fnSignature) {
  const idx = src.indexOf(fnSignature);
  if (idx === -1) throw new Error(`Could not find ${fnSignature}`);
  const openIdx = src.indexOf('{', idx + fnSignature.length);
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

const relaySeverityScores = extractObjectLiteral(relaySrc, 'RELAY_SEVERITY_SCORES');
const relayScoreWeights = extractObjectLiteral(relaySrc, 'RELAY_SCORE_WEIGHTS');

// ── Reconstruct the scorers as pure functions for output comparison ─────────

const digestFnBody = extractFunctionBody(digestSrc, 'function computeImportanceScore(');
const digestComputeImportanceScore = new Function(
  'level', 'source', 'corroborationCount', 'publishedAt',
  'SEVERITY_SCORES', 'SCORE_WEIGHTS', 'SOURCE_TIERS',
  `
    function getSourceTier(name) { return SOURCE_TIERS[name] ?? 4; }
    ${digestFnBody}
  `,
);

function digestScore(level, source, corroboration, publishedAt) {
  return digestComputeImportanceScore(
    level, source, corroboration, publishedAt,
    digestSeverityScores, digestScoreWeights, sharedSourceTiers,
  );
}

const relayFnBody = extractFunctionBody(relaySrc, 'function relayComputeImportanceScore(');
const relayComputeImportanceScore = new Function(
  'level', 'source', 'corroborationCount', 'publishedAt',
  'RELAY_SEVERITY_SCORES', 'RELAY_SCORE_WEIGHTS', 'RELAY_SOURCE_TIERS',
  `
    function relayGetSourceTier(name) { return RELAY_SOURCE_TIERS[name] ?? 4; }
    ${relayFnBody}
  `,
);

function relayScore(level, source, corroboration, publishedAt) {
  return relayComputeImportanceScore(
    level, source, corroboration, publishedAt,
    relaySeverityScores, relayScoreWeights, sharedSourceTiers,
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

describe('computeImportanceScore parity (digest ↔ relay)', () => {
  // Both scorers call Date.now() internally, so recency is non-deterministic
  // across calls but identical on the same call (we evaluate digest then relay
  // with the same wall-clock). publishedAt is "1h before the test ran" only
  // as a rough anchor — the exact recency score drifts with test run time,
  // which is acceptable because both sides see the same drift.
  const oneHourAgo = Date.now() - 3600_000;

  const cases = [
    ['critical', 'Reuters',          5],
    ['critical', 'BBC World',        3],
    ['critical', 'Defense One',      1],
    ['critical', 'Hacker News',      1],
    ['high',     'AP News',          2],
    ['high',     'Al Jazeera',       4],
    ['high',     'unknown-source',   1],   // unknown source defaults to tier 4
    ['medium',   'BBC World',        1],
    ['medium',   'Federal Reserve',  5],
    ['low',      'Reuters',          1],
    ['info',     'Reuters',          1],
    ['info',     'Hacker News',      5],
  ];

  for (const [level, source, corr] of cases) {
    it(`${level} / ${source} / corr=${corr}`, () => {
      const a = digestScore(level, source, corr, oneHourAgo);
      const b = relayScore(level, source, corr, oneHourAgo);
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
});
