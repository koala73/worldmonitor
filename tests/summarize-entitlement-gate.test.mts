/**
 * #4913 — anonymous dashboards flooded the premium-gated summarize-article
 * endpoint after #4675/#4687 gated its LLM spend server-side without a
 * client-side entitlement gate: every summarize attempt fanned out up to 3
 * doomed RPCs (ollama→groq→openrouter through the same gated endpoint)
 * before landing on the browser-T5 fallback anon users get anyway.
 *
 * Two layers under test (same shape as tests/classify-entitlement-gate for
 * #4865 — the sibling instance of this flood class):
 *   1. src/services/summarize-gate.ts — pure session gate (probe + timed
 *      suppression), node-test-safe (summarization.ts itself imports
 *      @/services/i18n etc. and cannot be loaded under tsx --test).
 *   2. Source-grep wiring assertions on summarization.ts — the gate is only
 *      effective if the dispatch path consults it and the 403 branch
 *      suppresses the chain.
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canAttemptServerSummarization,
  configureSummarizeGate,
  parseSummarizeRetryAfterMs,
  suppressServerSummarization,
  suppressServerSummarizationFor,
  SUMMARIZE_RETRY_AFTER_MAX_MS,
  SUMMARIZE_RETRY_AFTER_MIN_MS,
  SUMMARIZE_SUPPRESS_MS,
  __resetSummarizeGateForTests,
} from '../src/services/summarize-gate.ts';

describe('summarize-gate — entitlement probe + timed suppression', () => {
  beforeEach(() => {
    __resetSummarizeGateForTests();
  });

  it('allows by default when no probe is configured (fail-open; server still gates)', () => {
    assert.equal(canAttemptServerSummarization(), true);
  });

  it('denies when the probe reports not entitled', () => {
    configureSummarizeGate(() => false);
    assert.equal(canAttemptServerSummarization(), false);
  });

  it('allows when the probe reports entitled', () => {
    configureSummarizeGate(() => true);
    assert.equal(canAttemptServerSummarization(), true);
  });

  it('fails OPEN when the probe throws — a gating bug must not silence Pro summaries', () => {
    configureSummarizeGate(() => { throw new Error('gating module exploded'); });
    assert.equal(canAttemptServerSummarization(), true);
  });

  it('suppression denies even an entitled probe for the full window', () => {
    configureSummarizeGate(() => true);
    const t0 = 1_000_000;
    suppressServerSummarization(t0);
    assert.equal(canAttemptServerSummarization(t0), false);
    assert.equal(canAttemptServerSummarization(t0 + SUMMARIZE_SUPPRESS_MS - 1), false);
  });

  it('suppression expires after the window — self-heals a mid-session upgrade without event plumbing', () => {
    configureSummarizeGate(() => true);
    const t0 = 1_000_000;
    suppressServerSummarization(t0);
    assert.equal(canAttemptServerSummarization(t0 + SUMMARIZE_SUPPRESS_MS), true);
  });

  it('post-suppression attempts still consult the probe (free user stays denied)', () => {
    configureSummarizeGate(() => false);
    const t0 = 1_000_000;
    suppressServerSummarization(t0);
    assert.equal(canAttemptServerSummarization(t0 + SUMMARIZE_SUPPRESS_MS), false);
  });

  it('suppression window is long enough to matter (>= 5 minutes)', () => {
    assert.ok(SUMMARIZE_SUPPRESS_MS >= 5 * 60_000, `window too short: ${SUMMARIZE_SUPPRESS_MS}`);
  });

  it('parses Retry-After delta-seconds and HTTP dates deterministically', () => {
    const t0 = Date.parse('2026-07-11T12:00:00.000Z');
    assert.equal(parseSummarizeRetryAfterMs('90', t0), 90_000);
    assert.equal(
      parseSummarizeRetryAfterMs('Sat, 11 Jul 2026 12:02:00 GMT', t0),
      120_000,
    );
  });

  it('rejects malformed/expired Retry-After values and clamps untrusted extremes', () => {
    const t0 = Date.parse('2026-07-11T12:00:00.000Z');
    for (const value of [null, '', '-1', '1.5', 'not-a-date']) {
      assert.equal(parseSummarizeRetryAfterMs(value, t0), null, String(value));
    }
    assert.equal(parseSummarizeRetryAfterMs('0', t0), SUMMARIZE_RETRY_AFTER_MIN_MS);
    assert.equal(
      parseSummarizeRetryAfterMs('999999999999999999999999', t0),
      SUMMARIZE_RETRY_AFTER_MAX_MS,
    );
    assert.equal(
      parseSummarizeRetryAfterMs('Sat, 11 Jul 2026 11:59:59 GMT', t0),
      null,
    );
  });

  it('never shortens an existing server-directed suppression window', () => {
    configureSummarizeGate(() => true);
    const t0 = 1_000_000;
    suppressServerSummarizationFor(60_000, t0);
    suppressServerSummarizationFor(5_000, t0 + 1_000);

    assert.equal(canAttemptServerSummarization(t0 + 59_999), false);
    assert.equal(canAttemptServerSummarization(t0 + 60_000), true);
  });

  it('bounds direct suppression inputs as defense in depth', () => {
    configureSummarizeGate(() => true);
    const t0 = 1_000_000;
    suppressServerSummarizationFor(1, t0);
    assert.equal(canAttemptServerSummarization(t0 + SUMMARIZE_RETRY_AFTER_MIN_MS - 1), false);
    assert.equal(canAttemptServerSummarization(t0 + SUMMARIZE_RETRY_AFTER_MIN_MS), true);

    suppressServerSummarizationFor(Number.POSITIVE_INFINITY, t0);
    assert.equal(canAttemptServerSummarization(t0 + SUMMARIZE_RETRY_AFTER_MIN_MS), true);
  });

  it('keeps state separate from classify-gate — a summarize 403 must not silence classification', async () => {
    const classifyGate = await import('../src/services/classify-gate.ts');
    classifyGate.__resetClassifyGateForTests();
    suppressServerSummarization();
    assert.equal(classifyGate.canAttemptAiClassification(), true);
    __resetSummarizeGateForTests();
  });
});

describe('summarization.ts wiring (source-grep — module not loadable under node:test)', () => {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(
    path.join(dirname, '..', 'src', 'services', 'summarization.ts'),
    'utf8',
  );

  it('tryApiProvider consults canAttemptServerSummarization() before dispatching the RPC', () => {
    const fn = src.slice(src.indexOf('async function tryApiProvider'));
    const gateIdx = fn.indexOf('canAttemptServerSummarization()');
    const rpcIdx = fn.indexOf('premiumNewsClient.summarizeArticle');
    assert.ok(gateIdx > -1, 'tryApiProvider must call canAttemptServerSummarization()');
    assert.ok(rpcIdx > -1, 'expected premiumNewsClient.summarizeArticle in tryApiProvider');
    assert.ok(gateIdx < rpcIdx, 'the gate must run BEFORE the RPC is dispatched');
  });

  it('a server 403 suppresses the provider chain (entitlement drift must not recreate the flood)', () => {
    // Duck-typed status check: a value import of the generated client's
    // ApiError would pull the RPC client chunk into the main static graph
    // and fail the eager-chunk budget (caught on PR #4915's first CI run).
    assert.match(src, /getRpcErrorStatusCode\(error\) === 403/, 'must branch on 403 explicitly via the duck-typed helper');
    const branch = src.slice(src.indexOf('getRpcErrorStatusCode(error) === 403'));
    assert.ok(
      branch.indexOf('suppressServerSummarization()') > -1,
      '403 branch must call suppressServerSummarization()',
    );
  });

  it('a premium 429 consumes Retry-After at the fetch boundary before provider fan-out continues', () => {
    const clientInit = src.slice(
      src.indexOf('const premiumNewsClient'),
      src.indexOf('// #4913'),
    );
    assert.match(clientInit, /response\.status === 429/, 'premium fetch boundary must inspect 429 responses');
    assert.match(
      clientInit,
      /parseSummarizeRetryAfterMs\(response\.headers\.get\('Retry-After'\)\)/,
      '429 path must parse the server Retry-After header',
    );
    assert.match(
      clientInit,
      /suppressServerSummarizationFor\(retryAfterMs\)/,
      'valid Retry-After must suppress future premium dispatches',
    );
    assert.match(
      clientInit,
      /retryAfterMs === null[\s\S]*suppressServerSummarization\(\)/,
      'malformed/missing Retry-After must still stop the current provider fan-out',
    );
  });

  it('gate probe is wired to hasPremiumAccess (dual-signal entitlement)', () => {
    assert.match(src, /configureSummarizeGate\(\s*\(\)\s*=>\s*hasPremiumAccess\(\)/);
  });

  it('every premium dispatch flows through tryApiProvider (single choke point)', () => {
    // If a second call site of premiumNewsClient.summarizeArticle appears
    // outside tryApiProvider, it bypasses the gate — force the author here.
    const matches = src.match(/premiumNewsClient\.summarizeArticle/g) ?? [];
    assert.equal(matches.length, 1, 'premiumNewsClient.summarizeArticle must have exactly one call site (inside tryApiProvider)');
  });

  it('translateText stays ungated — mode=translate is the server-allowed anon path', () => {
    const fn = src.slice(src.indexOf('export async function translateText'));
    assert.ok(fn.indexOf("mode: 'translate'") > -1, 'translateText must use mode=translate');
    assert.ok(
      fn.indexOf('newsClient.summarizeArticle') > -1,
      'translateText must use the plain newsClient (anon-allowed), not the premium client',
    );
    const nextFnIdx = fn.indexOf('canAttemptServerSummarization');
    assert.equal(nextFnIdx, -1, 'translateText must not consult the premium gate');
  });
});
