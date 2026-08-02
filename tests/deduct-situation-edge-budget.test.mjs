import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// deduct-situation runs on the Vercel Edge gateway
// (api/intelligence/v1/[rpc].ts → runtime: 'edge'), which enforces a 25s
// initial-response ceiling. The LLM reasoning budget must fail closed to the
// handler's graceful `provider: 'error'` degradation BEFORE the platform
// kills the invocation — a budget above the ceiling is unreachable: 7d of
// Axiom route telemetry (2026-07) shows no successful response past 23.6s,
// while slower runs surface as client 504s with the LLM spend wasted and
// nothing cached (WORLDMONITOR-VP, #5147).
//
// Source-text extraction (same pattern as csp-filter.test.mjs) so the test
// doesn't drag the handler's redis/llm import graph into the runner.
const src = readFileSync(
  resolve(__dirname, '../server/worldmonitor/intelligence/v1/deduct-situation.ts'),
  'utf-8',
);

function constVal(name, known = {}) {
  const m = src.match(new RegExp(`const ${name} = ([^;]+);`));
  assert.ok(m, `const ${name} must exist in deduct-situation.ts`);
  let expr = m[1].split('//')[0].trim();
  for (const [k, v] of Object.entries(known)) {
    expr = expr.replaceAll(k, String(v));
  }
  // eslint-disable-next-line no-new-func
  return new Function(`"use strict"; return (${expr});`)();
}

describe('deduct-situation edge response budget (WORLDMONITOR-VP / #5147)', () => {
  it('names the Vercel edge initial-response ceiling at 25s', () => {
    assert.equal(constVal('VERCEL_INITIAL_RESPONSE_LIMIT_MS'), 25_000);
  });

  it('LLM budget fits under the edge ceiling with at least a 2s guard band', () => {
    const limit = constVal('VERCEL_INITIAL_RESPONSE_LIMIT_MS');
    const budget = constVal('DEDUCT_TIMEOUT_MS', {
      VERCEL_INITIAL_RESPONSE_LIMIT_MS: limit,
      RESPONSE_GUARD_BAND_MS: constVal('RESPONSE_GUARD_BAND_MS'),
    });
    assert.ok(
      budget <= limit - 2_000,
      `DEDUCT_TIMEOUT_MS (${budget}ms) must leave ≥2s of guard band under the ${limit}ms edge ceiling`,
    );
  });

  it('LLM budget stays above the observed reasoning p95 (~17.5s) so real runs are not starved', () => {
    const budget = constVal('DEDUCT_TIMEOUT_MS', {
      VERCEL_INITIAL_RESPONSE_LIMIT_MS: constVal('VERCEL_INITIAL_RESPONSE_LIMIT_MS'),
      RESPONSE_GUARD_BAND_MS: constVal('RESPONSE_GUARD_BAND_MS'),
    });
    assert.ok(budget >= 20_000, `DEDUCT_TIMEOUT_MS (${budget}ms) must stay ≥20s (LLM stage p95 ≈ 17.5s)`);
  });

  it('cache safety net still sits above the LLM budget so the LLM bound wins (#3539)', () => {
    // The inflight-wrapper bound must exceed the LLM's own bound; the exact
    // +5s relationship is asserted as source text so a refactor that inverts
    // the ordering fails loudly.
    assert.match(src, /timeoutMs: DEDUCT_TIMEOUT_MS \+ 5_000/);
  });
});
