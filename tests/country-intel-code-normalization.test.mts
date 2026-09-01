/**
 * Country codes sent by the deep-dive panel must survive the generated
 * validation layer regardless of input case.
 *
 * History: the 2026-08-01 security fix (GHSA-cmj5-cfhr-w964) enabled generated
 * request validation, whose country rules demand `^[A-Z]{2}$`. The panel in
 * src/app/country-intel.ts forwarded `page.getCode()` verbatim, and codes
 * arrive lowercase via deep links — so from Aug 1 on, ~40 real users/day
 * opened a country page and the stock-index and facts sections silently died
 * with a 400 (get-country-facts and get-country-stock-index failed in
 * lockstep: 271 errors each from the same 185 IPs in one week, first-seen
 * 33ms apart). The line-313 guard `code.toUpperCase() === 'CN'` proves
 * lowercase codes flow through this module by design.
 *
 * Two halves, both load-bearing:
 *  1. Runtime: the REAL generated validator rejects lowercase and accepts
 *     uppercase for every RPC the panel calls — proving normalization is
 *     mandatory, so this test does not outlive the constraint it guards.
 *  2. Wiring: every countryCode the panel passes to an RPC goes through
 *     .toUpperCase(). `code` itself must stay untouched — it is compared
 *     against page.getCode() in race guards, so a blanket uppercase of the
 *     variable would break those identity checks.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { validateGeneratedRequest } from '../server/request-validator.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** RPC methods country-intel.ts calls with a caller-supplied country code. */
const PANEL_RPCS = [
  'getCountryStockIndex',
  'getCountryFacts',
  'getCountryRisk',
];

describe('generated validation vs. panel country codes', () => {
  for (const method of PANEL_RPCS) {
    it(`${method}: rejects lowercase, accepts uppercase`, () => {
      const lower = validateGeneratedRequest(method, { countryCode: 'de' });
      assert.ok(
        lower && lower.some((v) => v.field === 'countryCode'),
        `${method} accepted a lowercase code — if the validator relaxed, `
        + 'this suite is guarding a constraint that no longer exists',
      );
      const upper = validateGeneratedRequest(method, { countryCode: 'DE' });
      assert.equal(upper, undefined, `${method} must accept an uppercase code`);
    });
  }
});

describe('country-intel panel normalizes codes before every RPC', () => {
  const src = readFileSync(resolve(root, 'src/app/country-intel.ts'), 'utf-8');

  it('no RPC receives a raw countryCode', () => {
    // Every `countryCode:` argument in this file must be an explicit
    // .toUpperCase() expression. Enumerate them all so a NEW call site added
    // without normalization fails, not only the five known ones.
    // `;` in the stop set + a type-keyword filter: `countryCode: string;` in
    // interface/type positions is an annotation, not an RPC argument.
    const args = [...src.matchAll(/countryCode:\s*([^,};]+)/g)]
      .map((m) => m[1].trim())
      .filter((a) => !/^(string|number|boolean)$/.test(a));
    assert.ok(args.length >= 5, `expected at least the 5 known call sites, found ${args.length}`);
    const raw = args.filter((a) => !/\.toUpperCase\(\)$/.test(a));
    assert.deepEqual(
      raw, [],
      `countryCode passed to an RPC without .toUpperCase(): ${raw.join(', ')} — `
      + 'the generated validator rejects lowercase with a 400',
    );
  });

  it('the code variable itself keeps its original case for the race guards', () => {
    // The identity guards compare against page.getCode(); uppercasing the
    // variable (instead of the RPC argument) would silently break them.
    assert.match(
      src, /getCode\(\)\s*===\s*code/,
      'expected at least one identity guard comparing raw code — if this moved, re-check the normalization strategy',
    );
  });
});
