import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { collapseAdjacentClassQuantifiers } from '../server/request-validator.ts';
import { GENERATED_MESSAGE_RULES } from '../src/generated/server/request_validation.ts';

// ---------------------------------------------------------------------------
// Why this test exists
// ---------------------------------------------------------------------------
//
// Proto `string.pattern` rules are authored against RE2: linear-time, no backtracking,
// but a hard cap of 1000 on a single repetition. Authors therefore split a longer bound
// into two adjacent quantifiers over the same class — free under RE2, quadratic under
// JavaScript's backtracking RegExp, which is the engine this validator actually uses.
//
// The Company Monitoring cursor pattern measured 21ms/op at 800 chars and 30-337ms/op at
// 2KB before collapsing, versus ~0.01ms after. The rewrite is only safe because for any
// set S, `S{a,b}S{c,d}` accepts exactly `S{a+c,b+d}` — so these tests pin BOTH halves:
// the language is unchanged, and the cost actually drops.

const CURSOR = '^cmc1\\.[A-Za-z0-9_-]{16,1000}[A-Za-z0-9_-]{0,536}\\.[A-Za-z0-9_-]{43}$';

describe('collapseAdjacentClassQuantifiers', () => {
  it('merges adjacent bounded repeats of an identical class', () => {
    assert.equal(
      collapseAdjacentClassQuantifiers(CURSOR),
      '^cmc1\\.[A-Za-z0-9_-]{16,1536}\\.[A-Za-z0-9_-]{43}$',
    );
  });

  it('preserves the accepted language, including the exact bounds', () => {
    const before = new RegExp(CURSOR);
    const after = new RegExp(collapseAdjacentClassQuantifiers(CURSOR));
    for (const midLen of [0, 1, 15, 16, 17, 999, 1000, 1001, 1535, 1536, 1537]) {
      const sample = `cmc1.${'a'.repeat(midLen)}.${'b'.repeat(43)}`;
      assert.equal(after.test(sample), before.test(sample), `midLen ${midLen} must classify identically`);
    }
    // Wrong signature length must still fail on both.
    for (const tailLen of [42, 44]) {
      const sample = `cmc1.${'a'.repeat(64)}.${'b'.repeat(tailLen)}`;
      assert.equal(after.test(sample), before.test(sample), `tailLen ${tailLen} must classify identically`);
    }
  });

  it('leaves patterns with no adjacent identical-class repeats untouched', () => {
    for (const pattern of [
      '^[A-Z]{3}$',
      '^@?[A-Za-z0-9_]{1,15}$',
      '^cm_company_[0-9A-HJKMNP-TV-Z]{26}$',
      '^(?:www\\.)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,}$',
      '^[a-z]{2,4}[0-9]{1,2}$',
    ]) {
      assert.equal(collapseAdjacentClassQuantifiers(pattern), pattern);
    }
  });

  it('bounds worst-case matching time on a non-matching 2KB input', () => {
    const collapsed = new RegExp(collapseAdjacentClassQuantifiers(CURSOR));
    const attack = `cmc1.${'a'.repeat(2000)}`;
    const started = process.hrtime.bigint();
    for (let i = 0; i < 200; i += 1) collapsed.test(attack);
    const msPerOp = Number(process.hrtime.bigint() - started) / 1e6 / 200;
    // The un-collapsed form measured 30-337ms/op here. A generous ceiling still fails
    // loudly if the collapse ever stops being applied.
    assert.ok(msPerOp < 1, `expected sub-millisecond matching, got ${msPerOp.toFixed(3)}ms/op`);
  });

  it('every shipped proto pattern is free of adjacent identical-class repeats after collapse', () => {
    // Repo-wide sweep: catches a future proto that reintroduces the RE2 workaround.
    const rules = GENERATED_MESSAGE_RULES as Record<string, { fields: Record<string, { stringPattern?: string }> }>;
    for (const [message, def] of Object.entries(rules)) {
      for (const [field, rule] of Object.entries(def.fields ?? {})) {
        if (!rule.stringPattern) continue;
        const collapsed = collapseAdjacentClassQuantifiers(rule.stringPattern);
        assert.equal(
          collapseAdjacentClassQuantifiers(collapsed),
          collapsed,
          `${message}.${field} still has collapsible adjacent quantifiers after one pass`,
        );
      }
    }
  });
});
