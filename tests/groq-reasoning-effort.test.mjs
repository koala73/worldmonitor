// Every Groq provider entry must send reasoning control.
//
// `openai/gpt-oss-*` are REASONING models: left to their defaults they spend
// the request's `max_tokens` budget on hidden reasoning tokens and return a
// truncated fragment, or nothing. Every other provider in every chain already
// declares reasoning off — Ollama sends `think: false`, all three OpenRouter
// rungs send `reasoning: { enabled: false }` — and Groq was the single
// provider that sent nothing. It was not a one-off: all seven Groq entries
// omitted it identically, which is how the omission survived.
//
// Measured against the live Groq API on 2026-08-28, same prompt,
// `max_tokens: 150`:
//
//   as production sends it   finish=length  content=38ch   reasoning=672ch  150 tokens
//   reasoning_effort: 'low'  finish=stop    content=190ch  reasoning=26ch    52 tokens
//
// That is the `empty` (109 events) and `length` (41 events) half of Groq's
// 27.6% success rate over the 7 days to 2026-08-28 — 543 calls, 393 failures.
// The remaining failures are `http_429`, which is quota, not this bug.
//
// The same failure mode is documented for reasoning models in
// `server/_shared/llm.ts` (`callLlmReasoning`, #4983): a small max_tokens plus
// hidden reasoning returns empty content.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GROQ_REASONING_EXTRA_BODY } from '../scripts/_llm-model-timeouts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every file that builds a Groq provider entry. Derived from
 * `rg -l 'api\.groq\.com' scripts/ server/` minus the non-chain hits
 * (`source-attribution` allowlist, `llm-health` probe URL, the Tauri sidecar's
 * /models reachability check).
 */
const GROQ_CHAIN_FILES = [
  'scripts/lib/llm-chain.cjs',
  'scripts/seed-insights.mjs',
  'scripts/seed-forecasts.mjs',
  'scripts/ais-relay.cjs',
  'scripts/regional-snapshot/weekly-brief.mjs',
  'scripts/regional-snapshot/narrative.mjs',
  'server/_shared/llm.ts',
];

const GROQ_ENTRY_PATTERN = /apiUrl:\s*['"]https:\/\/api\.groq\.com\/openai\/v1\/chat\/completions['"][\s\S]{0,700}?extraBody:\s*(?:model\.startsWith\('openai\/gpt-oss-'\)[\s\S]{0,100}?\?\s*)?GROQ_REASONING_EXTRA_BODY/;

const EXTRA_BODY_FORWARDING_PATTERNS = {
  'scripts/ais-relay.cjs': [
    /provider\.extraBody\s*\|\|\s*\{\}/,
    /\.\.\.extraBody/,
  ],
  'server/_shared/llm.ts': [/\.\.\.creds\.extraBody/],
};

describe('Groq reasoning control', () => {
  it('exports a shared extra-body constant rather than a per-site literal', () => {
    // One seam, because seven copies is exactly how the omission spread.
    assert.equal(typeof GROQ_REASONING_EXTRA_BODY, 'object');
    assert.equal(
      GROQ_REASONING_EXTRA_BODY.reasoning_effort, 'low',
      'Groq rejects `none` — it accepts only low|medium|high (verified live 2026-08-28)',
    );
  });

  it('every Groq chain entry sends it', () => {
    const offenders = [];
    for (const rel of GROQ_CHAIN_FILES) {
      const src = readFileSync(resolve(root, rel), 'utf8');
      assert.ok(/api\.groq\.com/.test(src), `${rel}: no longer builds a Groq entry — update this list`);
      const forwardingPatterns = EXTRA_BODY_FORWARDING_PATTERNS[rel]
        ?? [/\.\.\.\(?provider\.extraBody/];
      if (!GROQ_ENTRY_PATTERN.test(src) || forwardingPatterns.some(pattern => !pattern.test(src))) {
        offenders.push(rel);
      }
    }
    assert.deepEqual(offenders, [],
      'Groq entries missing reasoning control — they will burn max_tokens on hidden reasoning');
  });

  it('the scan reaches real files, so it cannot pass vacuously', () => {
    // A file list that silently stopped resolving would make the guard above
    // green on zero evidence.
    for (const rel of GROQ_CHAIN_FILES) {
      assert.ok(readFileSync(resolve(root, rel), 'utf8').length > 500, `${rel} did not resolve`);
    }
    assert.ok(GROQ_CHAIN_FILES.length >= 7, 'the sweep found seven call sites');
  });
});
