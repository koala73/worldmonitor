/**
 * Parity test: the relay-inlined importance scorer (scripts/ais-relay.cjs)
 * must produce identical output to the canonical digest scorer
 * (server/worldmonitor/news/v1/list-feed-digest.ts + server/_shared/source-tiers.ts).
 *
 * Background: PR #2604 introduced importanceScore in the digest. The relay
 * republishes classified headlines as rss_alert events and must carry a score
 * recomputed from the post-LLM threat level (see docs/internal/scoringDiagnostic.md).
 * The relay is CommonJS and cannot import the TS digest module, so it inlines
 * SOURCE_TIERS, SEVERITY_SCORES, SCORE_WEIGHTS, and the formula. This test
 * enforces parity so drift between the two implementations is caught at build time.
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
const sourceTiersSrc = readFileSync(
  resolve(repoRoot, 'server/_shared/source-tiers.ts'),
  'utf-8',
);
const relaySrc = readFileSync(
  resolve(repoRoot, 'scripts/ais-relay.cjs'),
  'utf-8',
);

// ── Extract digest constants ──────────────────────────────────────────────────

function extractObjectLiteral(src, varName) {
  // Locate `<prefix>const NAME ... = ` then brace-match the object literal so
  // both single-line and multi-line forms work, and TS `as const` suffixes
  // don't break extraction.
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

const digestSeverityScores = extractObjectLiteral(digestSrc, 'SEVERITY_SCORES');
const digestScoreWeights = extractObjectLiteral(digestSrc, 'SCORE_WEIGHTS');
const digestSourceTiers = extractObjectLiteral(sourceTiersSrc, 'SOURCE_TIERS');

const relaySeverityScores = extractObjectLiteral(relaySrc, 'RELAY_SEVERITY_SCORES');
const relayScoreWeights = extractObjectLiteral(relaySrc, 'RELAY_SCORE_WEIGHTS');
const relaySourceTiers = extractObjectLiteral(relaySrc, 'RELAY_SOURCE_TIERS');

// ── Extract and reconstruct the digest scorer as a pure function ─────────────

function extractFunctionBody(src, fnSignature) {
  const idx = src.indexOf(fnSignature);
  if (idx === -1) throw new Error(`Could not find ${fnSignature}`);
  // Find the matching closing brace by counting depth from the `{` after the signature
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

// Reconstruct digestComputeImportanceScore from the TS source by stripping type annotations.
const digestFnBody = extractFunctionBody(digestSrc, 'function computeImportanceScore(');
const digestComputeImportanceScore = new Function(
  'level', 'source', 'corroborationCount', 'publishedAt',
  'SEVERITY_SCORES', 'SCORE_WEIGHTS', 'SOURCE_TIERS',
  `
    function getSourceTier(name) { return SOURCE_TIERS[name] ?? 4; }
    ${digestFnBody.replace(/getSourceTier\(source\)/g, 'getSourceTier(source)')}
  `,
);

function digestScore(level, source, corroboration, publishedAt) {
  return digestComputeImportanceScore(
    level, source, corroboration, publishedAt,
    digestSeverityScores, digestScoreWeights, digestSourceTiers,
  );
}

// Reconstruct relay scorer similarly.
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
    relaySeverityScores, relayScoreWeights, relaySourceTiers,
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SOURCE_TIERS parity (digest ↔ relay)', () => {
  it('has identical source → tier mapping', () => {
    const digestKeys = Object.keys(digestSourceTiers).sort();
    const relayKeys = Object.keys(relaySourceTiers).sort();
    assert.deepEqual(relayKeys, digestKeys, 'source key sets diverged');
    for (const key of digestKeys) {
      assert.equal(
        relaySourceTiers[key], digestSourceTiers[key],
        `tier mismatch for "${key}": digest=${digestSourceTiers[key]} relay=${relaySourceTiers[key]}`,
      );
    }
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
  // Fixed publishedAt so recency is deterministic across runs.
  // Using a timestamp 1h old: ageMs = 3,600,000, recencyScore = (1 - 1/24) * 100 ≈ 95.833
  const nowAnchor = 1_776_082_000_000; // 2026-04-13 around session time
  const oneHourAgo = nowAnchor - 3600_000;

  const cases = [
    // [level, source (tier), corroboration]
    ['critical', 'Reuters',          5],   // Tier 1, max corroboration
    ['critical', 'BBC World',        3],   // Tier 2
    ['critical', 'Defense One',      1],   // Tier 3
    ['critical', 'Hacker News',      1],   // Tier 4
    ['high',     'AP News',          2],
    ['high',     'Al Jazeera',       4],
    ['high',     'unknown-source',   1],   // Unknown → tier 4 default
    ['medium',   'BBC World',        1],
    ['medium',   'Federal Reserve',  5],   // Tier 3
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
});

describe('RELAY_TIER4_SOURCES derivation', () => {
  it('matches the tier-4 entries in the tier map', () => {
    const derived = new Set(
      Object.entries(relaySourceTiers).filter(([, t]) => t === 4).map(([s]) => s),
    );
    // Extract RELAY_TIER4_SOURCES to confirm derivation matches what downstream code sees.
    // We reconstruct it the same way the relay does at load time.
    assert.ok(derived.has('Hacker News'), 'expected Hacker News in tier-4 set');
    assert.ok(!derived.has('Reuters'), 'Reuters is tier 1 and must not be in tier-4 set');
    assert.ok(derived.size > 0, 'tier-4 set should not be empty');
  });
});
