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

const __dirname = dirname(fileURLToPath(import.meta.url));
const relaySrc = readFileSync(
  resolve(__dirname, '..', 'scripts', 'ais-relay.cjs'),
  'utf-8',
);

describe('ais-relay importanceScore publish path', () => {
  it('carries corroborationCount into allTitles', () => {
    assert.match(
      relaySrc,
      /allTitles\.set\([^)]*[\s\S]*?corroborationCount:\s*item\.corroborationCount/,
      'allTitles.set must capture item.corroborationCount from the digest response',
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

  it('relayComputeImportanceScore is defined once at module scope', () => {
    const defs = relaySrc.match(/function\s+relayComputeImportanceScore\s*\(/g) || [];
    assert.equal(defs.length, 1, `expected single definition of relayComputeImportanceScore, found ${defs.length}`);
  });
});
