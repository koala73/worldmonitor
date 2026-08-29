// `classify-event` must leave enough token budget for a REASONING fallback.
//
// The stage asks for a 2-field JSON object and ran on `maxTokens: 50`, which
// is ample for the DeepSeek primary — 4,264 successful calls over the 7 days
// to 2026-08-29 used p50=10, p95=11, max=12 completion tokens, never within
// 38 of the ceiling.
//
// The Groq fallback is `openai/gpt-oss-*`, a REASONING model. Even with
// `reasoning_effort: 'low'` (#7289) it still spends some of the budget on
// hidden reasoning before emitting content, so at 50 the JSON is cut mid-key
// and the validator — correctly — rejects it. Observed in production
// 2026-08-28T19:01:35Z: `validate_reject`, `tokens_completion: 50`, exactly
// the ceiling.
//
// Measured against the live Groq API, six representative headlines from the
// stage's own system prompt:
//
//   no reasoning control @ 50   0/6 valid   6 hit the cap   (pre-#7289)
//   reasoning_effort low @ 50   4/6 valid   2 hit the cap   (the residue)
//   reasoning_effort low @ 120  6/6 valid   0 hit the cap
//
// The truncation is dispositive rather than inferred — the returned content
// was the literal string `{"level":"`.
//
// Raising a `max_tokens` CEILING costs nothing for a model that answers in 10
// tokens; it only changes who gets truncated. This is the fallback-only
// scenario the fallback exists for: when the primary is down, a third of
// classifications were silently degrading to `classification: undefined`.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(root, 'server/worldmonitor/intelligence/v1/classify-event.ts');

/**
 * Worst-case hidden-reasoning overhead observed from `gpt-oss-20b` at
 * `reasoning_effort: 'low'`, plus the ~12 tokens the JSON itself needs. The
 * floor is what the test enforces; the exact configured value may exceed it.
 */
const MIN_HEADROOM_TOKENS = 100;

describe('classify-event token budget leaves room for a reasoning fallback', () => {
  const src = readFileSync(SRC, 'utf8');

  it('requests enough tokens that a reasoning model can still close the JSON', () => {
    const m = src.match(/maxTokens:\s*(\d+)/);
    assert.ok(m, 'classify-event must declare an explicit maxTokens');
    const maxTokens = Number(m[1]);
    assert.ok(
      maxTokens >= MIN_HEADROOM_TOKENS,
      `maxTokens=${maxTokens} truncates the Groq fallback mid-JSON — measured 4/6 valid at 50, 6/6 at 120`,
    );
  });

  it('still bounds the budget — this is headroom, not an open tap', () => {
    // The stage returns {"level":"...","category":"..."} and nothing else. A
    // ceiling that drifted into the thousands would stop being a guard against
    // a runaway generation on ~4k calls/week.
    const maxTokens = Number(src.match(/maxTokens:\s*(\d+)/)[1]);
    assert.ok(maxTokens <= 256, `maxTokens=${maxTokens} is far past what a two-field JSON object needs`);
  });

  it('records why the ceiling is not simply the primary p95', () => {
    // Without the rationale in-file the next person sees a 2-field JSON asking
    // for 120 tokens against a p95 of 11 and "tidies" it back to 50,
    // reintroducing the fallback truncation. Guarding the comment is cheap
    // relative to re-diagnosing it from a single production event.
    assert.match(
      src,
      /reasoning/i,
      'the maxTokens choice must explain the reasoning-model headroom it exists for',
    );
  });
});
