/**
 * Regression test: scripts/ais-relay.cjs must recompute importanceScore from
 * the post-LLM level when publishing rss_alert events — never reuse the
 * stale digest score (docs/internal/scoringDiagnostic.md §2, §9 Step 1).
 *
 * The relay is a large CommonJS script with side effects at require time, so
 * we verify the contract by reading the source and asserting the publish site
 * calls relayComputeImportanceScore(level, …) rather than reading
 * meta.importanceScore.
 *
 * Run: node --test tests/relay-importance-recompute.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const { reachesRealtimeRules } = createRequire(import.meta.url)('../scripts/lib/news-story-key.cjs');

const __dirname = dirname(fileURLToPath(import.meta.url));
const relaySrc = readFileSync(
  resolve(__dirname, '..', 'scripts', 'ais-relay.cjs'),
  'utf-8',
);
const candidateGateSrc = readFileSync(
  resolve(__dirname, '..', 'scripts', 'lib', 'digest-stale-gate.cjs'),
  'utf-8',
);

describe('ais-relay importanceScore publish path', () => {
  it('carries corroborationCount into allTitles', () => {
    assert.match(
      relaySrc,
      /buildClassifyCandidateMap\(digest, xCandidates, variant, classifyNow, RECENCY_GATE_MS\)/,
      'the relay must build allTitles through the executable candidate helper',
    );
    assert.match(
      candidateGateSrc,
      /candidates\.set\(item\.title,[\s\S]*?corroborationCount:\s*item\.corroborationCount/,
      'the candidate helper must capture item.corroborationCount from the digest response',
    );
  });

  it('publishes a recomputed importanceScore using the post-LLM level', () => {
    // Anchor: the classify publish site is inside the LLM-classified critical/high branch.
    const branchStart = relaySrc.indexOf("if (level === 'critical' || level === 'high')");
    assert.ok(branchStart !== -1, 'classify critical/high branch not found');
    // The end of the publishNotificationEvent call.
    const branchEnd = relaySrc.indexOf('[Notify] Classify publish error', branchStart);
    assert.ok(branchEnd !== -1, 'classify publish call not found');
    const block = relaySrc.slice(branchStart, branchEnd);
    assert.match(
      block,
      /relayComputeImportanceScore\(\s*level\s*,/,
      'relay must call relayComputeImportanceScore(level, …) before publish',
    );
  });

  it('does NOT publish meta.importanceScore (the stale pre-LLM value)', () => {
    const branchStart = relaySrc.indexOf("if (level === 'critical' || level === 'high')");
    const branchEnd = relaySrc.indexOf('[Notify] Classify publish error', branchStart);
    const block = relaySrc.slice(branchStart, branchEnd);
    assert.ok(
      !/importanceScore:\s*meta\.importanceScore\b/.test(block),
      'publish payload must not reuse meta.importanceScore — that is the stale digest score',
    );
  });

  it('includes corroborationCount on the published payload', () => {
    const branchStart = relaySrc.indexOf("if (level === 'critical' || level === 'high')");
    const branchEnd = relaySrc.indexOf('[Notify] Classify publish error', branchStart);
    const block = relaySrc.slice(branchStart, branchEnd);
    assert.match(
      block,
      /corroborationCount:\s*meta\.corroborationCount/,
      'published payload must include corroborationCount for shadow-log enrichment',
    );
  });

  it('does not proxy exact-story corroboration into entityCorroborationCount', () => {
    const branchStart = relaySrc.indexOf("if (level === 'critical' || level === 'high')");
    const branchEnd = relaySrc.indexOf('[Notify] Classify publish error', branchStart);
    const block = relaySrc.slice(branchStart, branchEnd);
    assert.match(
      block,
      /entityCorroborationCount:\s*0\b/,
      'relay must not award entity-corroboration bonus unless it computed entity corroboration',
    );
    assert.doesNotMatch(
      block,
      /entityCorroborationCount:\s*meta\.corroborationCount/,
      'meta.corroborationCount is already included through corroborationScore and must not be double-counted',
    );
  });

  it('relayComputeImportanceScore is defined once at module scope', () => {
    const defs = relaySrc.match(/function\s+relayComputeImportanceScore\s*\(/g) || [];
    assert.equal(defs.length, 1, `expected single definition of relayComputeImportanceScore, found ${defs.length}`);
  });
  it('scores recency from the later of publishedAt and the headline\'s first sighting (#10978)', () => {
    assert.match(
      relaySrc,
      /relayComputeImportanceScore\(\s*level,\s*meta\.source,\s*meta\.corroborationCount \?\? 1,[\s\S]*?Math\.max\(meta\.publishedAt \?\? Date\.now\(\), meta\.firstSeen \?\? 0\),/,
    );
  });
});

// The ADNOC miss (#10975): the first headline that named the attack was a Gulf
// News live blog, re-headlined at 07:00:46Z with its 03:21Z pubDate kept. It
// scored 81 against the realtime bar of 82. Runs the relay's real scorer.
describe('relay recency for a re-headlined live blog (#10978, ADNOC)', () => {
  const start = relaySrc.indexOf('const RELAY_SCORE_WEIGHTS');
  const end = relaySrc.indexOf('\nconst CLASSIFY_VALID_LEVELS', start);
  const tiers = JSON.parse(readFileSync(resolve(__dirname, '..', 'shared', 'source-tiers.json'), 'utf-8'));
  const title = 'Middle East War: Iran attacks Bahrain, ADNOC vessel hit in Hormuz, Kuwait drone threats keep Gulf on high alert as US hits Iran’s Qeshm';
  const publishedAt = Date.parse('2026-11-18T03:21:05Z');
  const firstSeen = Date.parse('2026-11-18T07:00:46.293Z');
  const queuedAt = Date.parse('2026-11-18T07:01:46.475Z');
  const score = (recencyFrom) => {
    assert.ok(start > 0 && end > start, 'scoring block not found');
    const context = {
      relayGetSourceTier: (source) => tiers[source] ?? 4,
      Date: { now: () => queuedAt }, Math, Number, String, RegExp,
    };
    vm.createContext(context);
    vm.runInContext(relaySrc.slice(start, end), context);
    return vm.runInContext('relayComputeImportanceScore', context)('critical', 'Gulf News', 1, recencyFrom, {
      title, classSource: 'llm', entityCorroborationCount: 0,
    });
  };

  it('scored 81 from the kept pubDate, under the bar', () => {
    assert.equal(score(publishedAt), 81);
  });

  it('reaches the bar from the first sighting, at the first ADNOC headline the relay saw', () => {
    assert.equal(score(Math.max(publishedAt, firstSeen)), 83);
    assert.ok(reachesRealtimeRules('critical', score(Math.max(publishedAt, firstSeen))));
  });
});
