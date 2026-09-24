/**
 * Live check that both OpenRouter free-chain models are still listed as free.
 *
 * Run with LIVE_OPENROUTER_FREE_MODELS_TESTS=1. The default test suite skips
 * the network work so OpenRouter availability does not affect deterministic CI.
 *
 * A model OpenRouter stops serving for free drops out of the public /models
 * listing while its `:free` slug starts answering HTTP 404 "This model is
 * unavailable for free". That happened to `openai/gpt-oss-20b:free` (found
 * 2026-08-28) and `minimax/minimax-m3:free` (found 2026-09-24, #8570), and each
 * time the backup leg was dead for an unknown span because nothing looked. The
 * listing needs no API key and spends no quota, so the probe asks it instead of
 * sending a completion; a rate-limited (429) free model is still listed, which
 * keeps transient upstream throttling from failing the check.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  OPENROUTER_FREE_BACKUP_MODEL,
  OPENROUTER_FREE_PRIMARY_MODEL,
} = require('../scripts/lib/llm-model-policy.cjs');

const LIVE = process.env.LIVE_OPENROUTER_FREE_MODELS_TESTS === '1';
const FREE_CHAIN = [OPENROUTER_FREE_PRIMARY_MODEL, OPENROUTER_FREE_BACKUP_MODEL];

describe('OpenRouter free chain policy', () => {
  it('keeps the primary and backup in different model families', () => {
    const vendor = (model) => model.split('/')[0];
    assert.notEqual(
      vendor(OPENROUTER_FREE_PRIMARY_MODEL),
      vendor(OPENROUTER_FREE_BACKUP_MODEL),
      'one vendor quota exhaustion must not take out both free legs',
    );
    for (const model of FREE_CHAIN) assert.match(model, /:free$/);
  });
});

describe(`OpenRouter free models live listing (${LIVE ? 'ENABLED' : 'SKIPPED - set LIVE_OPENROUTER_FREE_MODELS_TESTS=1'})`, { skip: !LIVE }, () => {
  it('lists every free-chain model at zero price', { timeout: 60_000 }, async () => {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Accept: 'application/json', 'User-Agent': 'worldmonitor-free-model-probe' },
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.ok, true, `OpenRouter /models returned HTTP ${response.status}`);
    const { data } = await response.json();
    assert.ok(Array.isArray(data) && data.length > 0, 'OpenRouter /models returned no models');

    const byId = new Map(data.map((entry) => [entry.id, entry]));
    const missing = FREE_CHAIN.filter((model) => !byId.has(model));
    assert.deepEqual(
      missing,
      [],
      `delisted from OpenRouter, so every call now returns HTTP 404: ${missing.join(', ')}. ` +
        'Pick a live replacement in scripts/lib/llm-model-policy.cjs and verify it with a real completion.',
    );
    for (const model of FREE_CHAIN) {
      const { pricing } = byId.get(model);
      assert.equal(Number(pricing?.prompt), 0, `${model} prompt price is ${pricing?.prompt}`);
      assert.equal(Number(pricing?.completion), 0, `${model} completion price is ${pricing?.completion}`);
    }
  });
});
