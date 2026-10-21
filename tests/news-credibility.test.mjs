// Per-headline credibility score (#6597) — distinct from importanceScore.
//
// importanceScore answers "how newsworthy is this?". credibilityScore answers
// "how much should I trust this source on this story?". A highly newsworthy
// RT flash still scores LOW on credibility because propaganda risk dominates.
//
// Run: node --test tests/news-credibility.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CREDIBILITY_CORROBORATION_CAP,
  CREDIBILITY_CORROBORATION_PER_SOURCE,
  CREDIBILITY_HIGH_RISK_CAP,
  CREDIBILITY_RISK_SCORES,
  CREDIBILITY_TIER_SCORES,
  CREDIBILITY_WEIGHTS,
  computeCredibilityScore,
} from '../shared/news-credibility.js';
import { getSourcePropagandaRisk } from '../shared/source-provenance.ts';
import { getSourceTier } from '../server/_shared/source-tiers.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readSrc = (rel) => readFileSync(resolve(root, rel), 'utf8');

function scoreFor(source, independentCorroborationCount = 1) {
  return computeCredibilityScore({
    sourceTier: getSourceTier(source),
    propagandaRisk: getSourcePropagandaRisk(source).risk,
    independentCorroborationCount,
  });
}

describe('computeCredibilityScore', () => {
  it('is bounded to 0–100', () => {
    assert.equal(
      computeCredibilityScore({
        sourceTier: 1,
        propagandaRisk: 'low',
        independentCorroborationCount: 99,
      }),
      100,
    );
    assert.equal(
      computeCredibilityScore({
        sourceTier: 9,
        propagandaRisk: 'high',
        independentCorroborationCount: -4,
      }) >= 0,
      true,
    );
  });

  it('does not use severity, recency, or diplomacy boosts', () => {
    const base = computeCredibilityScore({
      sourceTier: 1,
      propagandaRisk: 'low',
      independentCorroborationCount: 1,
    });
    const same = computeCredibilityScore({
      sourceTier: 1,
      propagandaRisk: 'low',
      independentCorroborationCount: 1,
      severity: 'critical',
      recencyScore: 100,
      diplomacyBoost: 18,
    });
    assert.equal(same, base);
  });

  it('raises score with independent corroboration, capped at five sources', () => {
    const one = computeCredibilityScore({
      sourceTier: 1,
      propagandaRisk: 'low',
      independentCorroborationCount: 1,
    });
    const five = computeCredibilityScore({
      sourceTier: 1,
      propagandaRisk: 'low',
      independentCorroborationCount: 5,
    });
    const six = computeCredibilityScore({
      sourceTier: 1,
      propagandaRisk: 'low',
      independentCorroborationCount: 6,
    });
    assert.ok(five > one);
    assert.equal(six, five);
    assert.equal(CREDIBILITY_CORROBORATION_CAP, 5);
    assert.equal(CREDIBILITY_CORROBORATION_PER_SOURCE, 20);
  });

  it('treats unreviewed sources as unknown, not independent journalism', () => {
    const unknown = computeCredibilityScore({
      sourceTier: 4,
      propagandaRisk: 'unknown',
      independentCorroborationCount: 1,
    });
    const independent = computeCredibilityScore({
      sourceTier: 4,
      propagandaRisk: 'low',
      independentCorroborationCount: 1,
    });
    assert.ok(unknown < independent);
    assert.equal(CREDIBILITY_RISK_SCORES.unknown < CREDIBILITY_RISK_SCORES.low, true);
  });

  it('caps high propaganda-risk sources so they cannot look highly credible', () => {
    const capped = computeCredibilityScore({
      sourceTier: 1,
      propagandaRisk: 'high',
      independentCorroborationCount: 5,
    });
    assert.ok(capped <= CREDIBILITY_HIGH_RISK_CAP);
    assert.equal(CREDIBILITY_HIGH_RISK_CAP, 40);
  });
});

describe('state-media vs wire — newsworthiness is not credibility', () => {
  it('a singleton RT story scores LOW on credibility', () => {
    assert.equal(getSourcePropagandaRisk('RT').risk, 'high');
    assert.equal(getSourceTier('RT'), 3);
    const rt = scoreFor('RT', 1);
    assert.ok(rt < 40, `RT credibility should be low, got ${rt}`);
  });

  it('a singleton Reuters story scores HIGH on credibility', () => {
    assert.equal(getSourcePropagandaRisk('Reuters').risk, 'low');
    assert.equal(getSourceTier('Reuters'), 1);
    const reuters = scoreFor('Reuters', 1);
    assert.ok(reuters >= 70, `Reuters credibility should be high, got ${reuters}`);
  });

  it('RT stays well below Reuters even when RT is independently corroborated', () => {
    const rt = scoreFor('RT', 5);
    const reuters = scoreFor('Reuters', 1);
    assert.ok(rt <= CREDIBILITY_HIGH_RISK_CAP);
    assert.ok(rt < reuters);
    assert.ok(reuters - rt >= 30, `spread too small: Reuters ${reuters} vs RT ${rt}`);
  });

  it('weights prefer propaganda risk over source tier', () => {
    assert.ok(CREDIBILITY_WEIGHTS.propagandaRisk > CREDIBILITY_WEIGHTS.sourceTier);
    assert.ok(CREDIBILITY_WEIGHTS.sourceTier > CREDIBILITY_WEIGHTS.independentCorroboration);
    assert.equal(
      CREDIBILITY_WEIGHTS.sourceTier
        + CREDIBILITY_WEIGHTS.propagandaRisk
        + CREDIBILITY_WEIGHTS.independentCorroboration,
      1,
    );
    assert.deepEqual(CREDIBILITY_TIER_SCORES, { 1: 100, 2: 75, 3: 50, 4: 25 });
  });
});

describe('digest wiring (source-textual)', () => {
  const digestSrc = readSrc('server/worldmonitor/news/v1/list-feed-digest.ts');
  const protoSrc = readSrc('proto/worldmonitor/news/v1/news_item.proto');

  it('proto NewsItem has a credibility_score field distinct from importance_score', () => {
    assert.match(protoSrc, /int32 importance_score = 9;/);
    assert.match(protoSrc, /int32 credibility_score = 14;/);
    assert.match(protoSrc, /distinct from importance_score/);
  });

  it('list-feed-digest imports the shared scorer and writes credibilityScore', () => {
    assert.match(digestSrc, /from '\.\.\/\.\.\/\.\.\/\.\.\/shared\/news-credibility\.js'/);
    assert.match(digestSrc, /return computeCredibilityScore\(\{/);
    assert.match(
      digestSrc,
      /item\.credibilityScore = computeItemCredibilityScore\(item, scoringCorroboration\)/,
    );
    assert.match(digestSrc, /credibilityScore: item\.credibilityScore/);
  });

  it('does not replace or alias importanceScore', () => {
    assert.match(digestSrc, /item\.importanceScore = computeImportanceScore\(/);
    assert.doesNotMatch(digestSrc, /importanceScore\s*=\s*computeCredibilityScore/);
    assert.doesNotMatch(digestSrc, /credibilityScore\s*=\s*computeImportanceScore/);
  });
});

describe('UI, API, and methodology surfaces', () => {
  const panelSrc = readSrc('src/components/NewsPanel.ts');
  const credDoc = readSrc('docs/methodology/news-credibility.mdx');
  const digestDoc = readSrc('docs/methodology/news-digest-and-briefing.mdx');
  const openApiYaml = readSrc('docs/api/NewsService.openapi.yaml');
  const mcpCacheSrc = readSrc('api/mcp/registry/cache-tools.ts');
  const mcpNlpSrc = readSrc('api/mcp/registry/nlp-tools.ts');

  it('NewsPanel renders CRED badges and still sorts by importanceScore', () => {
    assert.match(panelSrc, /renderCredibilityBadge\(item\.source, item\)/);
    assert.match(panelSrc, /renderCredibilityBadge\(cluster\.primarySource/);
    assert.match(panelSrc, /a\.importanceScore \?\? 0/);
    assert.doesNotMatch(panelSrc, /sort\(\s*\(a, b\).*credibilityScore/s);
  });

  it('methodology page documents weights, high-risk cap, and distinctness', () => {
    assert.match(credDoc, /Propaganda risk \| `0\.50`/);
    assert.match(credDoc, /Source tier \| `0\.30`/);
    assert.match(credDoc, /Independent corroboration \| `0\.20`/);
    assert.match(credDoc, /capped at `40`/);
    assert.match(credDoc, /substituted for newsworthiness/);
    assert.match(digestDoc, /## Credibility Score/);
    assert.match(digestDoc, /Propaganda risk \| `0\.50`/);
    assert.match(digestDoc, /capped at `40`/);
  });

  it('OpenAPI NewsItem.credibilityScore is distinct from importanceScore', () => {
    assert.match(openApiYaml, /credibilityScore:\n\s+type: integer/s);
    assert.match(openApiYaml, /distinct from importance_score/);
    assert.match(openApiYaml, /capped at 40/);
    assert.match(openApiYaml, /source tier × 30%/);
    assert.match(openApiYaml, /propaganda risk × 50%/);
    assert.match(openApiYaml, /independent\n\s+corroboration × 20%/s);
  });

  it('MCP get_news_intelligence and get_news_clusters expose credibilityScore', () => {
    assert.match(mcpCacheSrc, /credibilityScore: \{ type: 'number'/);
    assert.match(mcpNlpSrc, /credibilityScore: \{\n\s+type: 'number'/s);
    assert.match(mcpNlpSrc, /const digestCredibilityScore = cluster\.credibilityScore/);
    assert.match(mcpNlpSrc, /credibilityScore: Number\.isFinite\(digestCredibilityScore\)/);
    assert.match(mcpNlpSrc, /: computeCredibilityScore\(\{/);
  });
});
