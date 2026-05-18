/**
 * Regression for issue #3803: api/seed-contract-probe.ts used
 * `secret !== expected` for the x-probe-secret header, opening a
 * timing oracle on RELAY_SHARED_SECRET. Every other internal-auth
 * endpoint in the codebase uses the `timingSafeEqual` helper from
 * server/_shared/internal-auth.ts.
 *
 * This test scans every file under api/ for the pattern of comparing a
 * locally-bound secret/token/key variable against an env-var value via
 * `===` / `!==`, and fails if any such site exists. The fix in each
 * case is to use `timingSafeEqual` (or `authenticateInternalRequest`
 * if the header is `Authorization: Bearer …`).
 *
 * The test is intentionally source-grep-based — it's runtime-independent
 * and catches the regression at lint/unit time without needing to spin
 * up the actual handler. Pattern documented in
 * ~/.claude/skills/test-ci-gotchas/reference/source-grep-regression-test-for-unexercisable-defensive-branch.md
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiDir = join(__dirname, '..', 'api');

// Variable-name fragments we treat as secret-bearing. Limited and
// specific to avoid false positives on innocuous variables that happen
// to contain "key".
const SECRET_VARS = ['secret', 'token', 'bearer', 'sharedSecret', 'apiSecret', 'authSecret'];

// Files that legitimately compare these against constants for reasons
// other than auth (e.g. test fixtures, config validation).
// Empty for now — the test starts strict; add documented exceptions if
// they come up with a comment explaining why the timing oracle doesn't
// apply.
const ALLOWLIST_FILES: ReadonlySet<string> = new Set([]);

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) {
      // Skip vendored / generated subdirs.
      if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
      out.push(...await walk(full));
    } else if (/\.(ts|js|mjs|cjs)$/.test(entry) && !/\.test\.[mc]?[jt]s$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('no non-timing-safe secret comparison in api/ (#3803)', () => {
  it('no `(secret|token|...) (===|!==) (process.env.* | expectedXxx)` comparison exists in any api/ source', async () => {
    const files = await walk(apiDir);
    const violations: string[] = [];

    // Match patterns like:
    //   secret !== expected                          (forward)
    //   token === process.env.FOO                    (forward)
    //   process.env.RELAY_SHARED_SECRET === secret   (reverse, yoda-style)
    //   expectedSecret !== token                     (reverse)
    // The two arms catch both operand orderings — Greptile review on
    // PR #3820 caught that a yoda-style or copy-pasted reverse
    // comparison would silently pass a forward-only guard.
    const varAlternation = SECRET_VARS.join('|');
    const forward = `\\b(?:${varAlternation})\\b\\s*(?:!==|===)\\s*(?:process\\.env\\.|expected\\b|EXPECTED\\b)`;
    const reverse = `(?:process\\.env\\.[A-Z_a-z]+|expected\\b|EXPECTED\\b)\\s*(?:!==|===)\\s*\\b(?:${varAlternation})\\b`;
    const pattern = new RegExp(`(?:${forward}|${reverse})`, 'i');

    for (const file of files) {
      const rel = file.slice(file.indexOf('/api/') + 1);
      if (ALLOWLIST_FILES.has(rel)) continue;
      const source = await readFile(file, 'utf8');
      // Strip JS comments so a doc comment mentioning the old pattern
      // doesn't false-positive the guard.
      const stripped = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      if (pattern.test(stripped)) {
        violations.push(rel);
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Non-timing-safe secret comparison detected in: ${violations.join(', ')}. ` +
        `Use timingSafeEqual from server/_shared/internal-auth.ts instead. See issue #3803.`,
    );
  });

  it('api/seed-contract-probe.ts uses timingSafeEqual for x-probe-secret (#3803 specific)', async () => {
    const source = await readFile(
      new URL('../api/seed-contract-probe.ts', import.meta.url),
      'utf8',
    );
    // Must import the helper.
    assert.match(
      source,
      /import\s*\{[^}]*\btimingSafeEqual\b[^}]*\}\s*from\s*['"][^'"]*internal-auth/,
      'seed-contract-probe.ts must import timingSafeEqual from internal-auth',
    );
    // Must invoke it for the x-probe-secret comparison.
    assert.match(
      source,
      /await\s+timingSafeEqual\s*\(\s*secret/,
      'seed-contract-probe.ts must call timingSafeEqual(secret, ...) for the x-probe-secret check',
    );
  });

  it('meta: the source-grep regex catches both forward and reverse comparison forms (#3820 review)', () => {
    // Reconstruct the same pattern used by the scan above. Keep this
    // in sync with the production regex — any change in one needs the
    // other. Greptile review on PR #3820 added the reverse arm; this
    // meta-test pins the coverage.
    const varAlternation = ['secret', 'token', 'bearer', 'sharedSecret', 'apiSecret', 'authSecret'].join('|');
    const forward = `\\b(?:${varAlternation})\\b\\s*(?:!==|===)\\s*(?:process\\.env\\.|expected\\b|EXPECTED\\b)`;
    const reverse = `(?:process\\.env\\.[A-Z_a-z]+|expected\\b|EXPECTED\\b)\\s*(?:!==|===)\\s*\\b(?:${varAlternation})\\b`;
    const pattern = new RegExp(`(?:${forward}|${reverse})`, 'i');

    // Each pair: [input, expected-match]
    const cases: Array<[string, boolean]> = [
      // Forward — must match.
      ['secret !== expected', true],
      ['token === process.env.FOO', true],
      ['if (sharedSecret !== process.env.RELAY_SHARED_SECRET) return', true],
      // Reverse — must match (this is what the Greptile review added).
      ['process.env.RELAY_SHARED_SECRET === secret', true],
      ['if (process.env.FOO !== token) return', true],
      ['EXPECTED === bearer', true],
      // Innocuous — must NOT match.
      ['const secret = "abc"', false],
      ['if (status === 200) return', false],
      ['userInput !== sanitizedInput', false],
      ['return process.env.FOO', false],
    ];

    for (const [input, shouldMatch] of cases) {
      assert.equal(
        pattern.test(input),
        shouldMatch,
        `pattern.test(${JSON.stringify(input)}) expected ${shouldMatch}`,
      );
    }
  });
});
