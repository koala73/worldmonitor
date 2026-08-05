/**
 * Regression for issue #3803: api/seed-contract-probe.ts used
 * `secret !== expected` for the x-probe-secret header, opening a
 * timing oracle on RELAY_SHARED_SECRET. Every other internal-auth
 * endpoint in the codebase uses the `timingSafeEqual` helper from
 * server/_shared/internal-auth.ts.
 *
 * This test scans every file under api/ for the pattern of comparing a
 * secret/token/bearer-bearing reference against an env-var value, an
 * `expected` constant, or ANOTHER secret-bearing reference via
 * `===` / `!==`, and fails if any such site exists. The fix in each
 * case is to use `timingSafeEqual` (or `authenticateInternalRequest`
 * if the header is `Authorization: Bearer …`).
 *
 * The identifier-vs-identifier arm exists because the original regex
 * required the right operand to be `process.env.*` or the bare word
 * `expected`, which meant the three most natural spellings of the bug all
 * sailed straight through:
 *   probeSecret !== expectedSecret     (`expected\b` never matches `expectedSecret`)
 *   probeSecret !== process.env.FOO    (`\bsecret\b` never matches inside `probeSecret`)
 *   secret === config.secret           (member expressions were not considered)
 * A guard that misses the natural spelling of the bug is a guard with no
 * teeth, so the meta-test below pins the matcher against an explicit
 * must-match / must-not-match table.
 *
 * The test is intentionally source-grep-based — it's runtime-independent
 * and catches the regression at lint/unit time without needing to spin
 * up the actual handler. Pattern documented in
 * ~/.claude/skills/test-ci-gotchas/reference/source-grep-regression-test-for-unexercisable-defensive-branch.md
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiDir = join(__dirname, '..', 'api');

// Variable-name fragments we treat as secret-bearing. Matched
// case-insensitively as a SUBSTRING of an identifier, so `secret` alone
// covers `probeSecret`, `sharedSecret`, `apiSecret`, `authSecret`,
// `RELAY_SHARED_SECRET`, … — the earlier compound entries were folded in
// when the matcher moved from whole-word to substring.
//
// Keep this list deliberate. A generic fragment like a bare `key` would
// flag `cacheKey`, `sortKey`, `redisKey` and drown the guard in noise; a
// disabled guard is worse than a narrow one.
const SECRET_VARS = ['secret', 'token', 'bearer'];

/**
 * Build the source-grep pattern. Module-scope (not exported: biome's
 * noExportsInTest forbids exports from a test file) so the meta-test table
 * below exercises the EXACT regex the real scan uses — a table testing a
 * copy-pasted duplicate proves nothing.
 *
 * Matches a secret-bearing reference compared with `===`/`!==` against
 * any of: `process.env.*`, a bare `expected`/`EXPECTED` constant, or
 * ANOTHER secret-bearing reference — in either operand order.
 *
 * The identifier-vs-identifier arm is the one that matters most in
 * practice: `probeSecret !== expectedSecret` is the most natural way to
 * write the #3803 bug, and the original `expected\b` right-hand arm sailed
 * straight past it because `expectedSecret` has no word boundary after
 * `expected`.
 *
 * Deliberately NOT matched: comparisons whose other operand is a string or
 * type literal (`typeof token === 'string'`), a nullish/undefined check, or
 * a plainly non-secret identifier. Those are not timing oracles on a
 * secret, and false positives get guards deleted.
 */
function buildSecretComparePattern(fragments: readonly string[] = SECRET_VARS): RegExp {
  const varAlternation = fragments.join('|');
  // A reference whose FINAL segment carries a secret fragment: `secret`,
  // `probeSecret`, `RELAY_SHARED_SECRET`, `req.headers.token`, `a.apiSecret`.
  //
  // The lookbehind rejects `.` as well as word chars, so the match must
  // start at the head of the member chain rather than mid-identifier or
  // mid-chain. That is what keeps `dot === token.length - 1` and
  // `err.code === 'missing_secret'` unflagged: the fragment-bearing segment
  // has to be the one the operator actually applies to.
  const member = `(?:[A-Za-z0-9_$]+\\.)*`;
  const ident = `(?<![A-Za-z0-9_$.])${member}[A-Za-z0-9_$]*(?:${varAlternation})[A-Za-z0-9_$]*(?![A-Za-z0-9_$])`;
  const env = `process\\.env\\.[A-Z_a-z][A-Z_a-z0-9]*`;
  // An env var whose NAME is secret-bearing. Comparing ANY local against one of
  // these is a timing oracle regardless of what the local is called — which is
  // the hole that `const a = req.headers.get('x-secret'); if (a !== process.env.X)`
  // used to slip through, since neither operand is a secret-NAMED identifier.
  const envSecret = `process\\.env\\.[A-Za-z0-9_]*(?:SECRET|TOKEN|BEARER|PASSWORD|PASSWD|API_?KEY)[A-Za-z0-9_]*`;
  // A header/param read whose KEY names a secret, compared inline without ever
  // being bound to a variable: `req.headers.get('x-probe-secret') !== expected`.
  // This is the codebase's dominant header idiom, so a guard that only sees
  // identifiers misses the most likely place the bug reappears.
  const anyIdent = `(?<![A-Za-z0-9_$.])${member}[A-Za-z0-9_$]+`;
  const secretGet = `\\.\\s*(?:get|getHeader)\\s*\\(\\s*['"\`][^'"\`]*(?:${varAlternation})[^'"\`]*['"\`]\\s*\\)`;
  // NOTE: the operator is bracketed by `\s*`, NOT `.*`. Whitespace is the
  // only thing it can step over, so an operand that begins with a quote is
  // unreachable — `ident` can never start matching inside a string literal.
  // This is what makes `tokenType === 'bearer'` safe despite `bearer` being
  // a fragment; see the minimal pair in PATTERN_CASES.
  const op = `\\s*(?:!==|===)\\s*`;
  // Forward also covers ident-vs-ident (symmetric, so no reverse needed).
  const forward = `${ident}${op}(?:process\\.env\\.|expected\\b|EXPECTED\\b|${ident})`;
  const reverse = `(?:${env}|expected\\b|EXPECTED\\b)${op}${ident}`;
  // Secret-named env var vs ANY identifier, either order.
  const envEither = `(?:${anyIdent}${op}${envSecret}|${envSecret}${op}${anyIdent})`;
  // Inline secret-named header read vs anything, either order.
  const getForward = `${secretGet}${op}(?:${anyIdent}|process\\.env\\.|expected\\b|EXPECTED\\b)`;
  const getReverse = `(?:${anyIdent}|${env}|expected\\b|EXPECTED\\b)${op}${anyIdent}${secretGet}`;
  return new RegExp(`(?:${forward}|${reverse}|${envEither}|${getForward}|${getReverse})`, 'i');
}

/**
 * THE SINGLE NORMALISATION SEAM between reading a file and matching it.
 *
 * Today it is the identity function, deliberately: the previous version of this
 * guard stripped comments here and the naive stripper ate 30.2% of api/ by bytes
 * (a `/*`-containing glob inside a `//` comment read as a block-comment opener
 * and swallowed 4160 bytes of api/mcp/types.ts including real exported code), so
 * violations in swallowed regions were invisible and the guard passed vacuously.
 *
 * Anything that ever transforms source before matching MUST go here rather than
 * inline at a call site, because the two tests below both run through this
 * function — the real scan and the planted-violation companion. That shared
 * routing is what makes the companion test a real safety net: a normalisation
 * step added here that eats source turns it red. When the companion had its own
 * private read-and-match loop, a stripper added to the real scan alone left it
 * green, which is exactly the vacuous-guard bug one level up.
 */
function normaliseForScan(source: string): string {
  return source;
}

/**
 * The contract for the matcher: every future edit to
 * buildSecretComparePattern must keep every row green, which makes regex
 * changes provable instead of hopeful.
 *
 * Rows are matched against RAW source, exactly as the real scan now does.
 */
const PATTERN_CASES: ReadonlyArray<{ src: string; match: boolean; why: string }> = [
  // ---- MUST MATCH: env-var comparisons (the original #3803 shape).
  { src: 'secret !== expected', match: true, why: '#3803 verbatim' },
  { src: 'token === process.env.FOO', match: true, why: 'forward vs env' },
  { src: 'if (sharedSecret !== process.env.RELAY_SHARED_SECRET) return', match: true, why: 'forward vs env, camelCase var' },
  // ---- MUST MATCH: reverse / yoda ordering (added by PR #3820 review).
  { src: 'process.env.RELAY_SHARED_SECRET === secret', match: true, why: 'yoda vs env' },
  { src: 'if (process.env.FOO !== token) return', match: true, why: 'yoda vs env' },
  { src: 'EXPECTED === bearer', match: true, why: 'yoda vs EXPECTED constant' },
  // ---- MUST MATCH: identifier-vs-identifier, the most natural way to
  // write the bug. `expected\b` never matched `expectedSecret`, so the
  // guard used to sail straight past all four of these.
  { src: 'probeSecret !== expectedSecret', match: true, why: 'ident vs ident' },
  { src: 'expectedSecret === probeSecret', match: true, why: 'ident vs ident, reversed' },
  { src: 'relaySharedSecret !== expectedSharedSecret', match: true, why: 'ident vs ident, both compound' },
  { src: 'token === expectedToken', match: true, why: 'ident vs ident, bare left operand' },
  // ---- MUST MATCH: compound secret name vs env var. `\b(?:secret)\b`
  // never matched inside `probeSecret`, so this shape leaked too.
  { src: 'if (probeSecret !== process.env.RELAY_SHARED_SECRET) return', match: true, why: 'compound name vs env' },
  { src: 'process.env.CRON_SECRET === incomingToken', match: true, why: 'compound name vs env, reversed' },
  { src: 'apiSecret !== process.env.API_SECRET', match: true, why: 'compound name still covered after fragment collapse' },
  { src: 'authSecret === expected', match: true, why: 'compound name still covered after fragment collapse' },
  // ---- MUST MATCH: member expressions. The secret often arrives as a
  // property (`req.headers`, a config object), not a bare local.
  { src: 'if (secret === config.secret) return', match: true, why: 'member expression on the right' },
  { src: 'if (req.headers.token !== expectedToken) return', match: true, why: 'member expression on the left' },
  { src: 'if (a.apiSecret === b.apiSecret) return', match: true, why: 'member expression on both sides' },

  // ---- MUST NOT MATCH: the correct idiom.
  { src: 'timingSafeEqual(secret, expectedSecret)', match: false, why: 'the CORRECT idiom — never flag it' },
  // ---- MUST NOT MATCH: presence / nullish checks.
  { src: 'if (!secret) return unauthorized()', match: false, why: 'presence check' },
  { src: 'secret == null', match: false, why: 'loose nullish check, not a comparison of values' },
  { src: 'token !== undefined', match: false, why: 'undefined is not secret-bearing' },
  { src: 'secret === null', match: false, why: 'null is not secret-bearing' },
  // ---- MUST NOT MATCH: comparisons against string / type literals.
  { src: "typeof token === 'string'", match: false, why: 'classic trap: type check, not a secret compare' },
  { src: 'typeof secret !== "string"', match: false, why: 'type check, double-quoted' },
  { src: "if (scheme.toLowerCase() !== 'bearer') return", match: false, why: 'scheme literal, not a secret value' },
  { src: "tokenType === 'bearer'", match: false, why: 'secret-ish name compared to a literal' },
  // Minimal pair isolating the quote as the discriminator: identical
  // source but for the quotes. The operator sub-pattern ends in `\s*`,
  // which cannot step over a `'`, so a quoted right operand can never
  // begin an ident match. Reviewers reasonably suspect the fragment
  // inside 'bearer' is reachable — these two rows prove it is not.
  { src: 'tokenType === bearerValue', match: true, why: 'UNQUOTED operand: a real ident-vs-ident compare' },
  { src: "tokenType === 'bearerValue'", match: false, why: 'same line quoted: a literal, unreachable by the matcher' },
  // ---- MUST NOT MATCH: non-secret right operand.
  { src: 'token === idx', match: false, why: 'second identifier is plainly not secret-bearing' },
  { src: 'if (tokenCount === 0) return', match: false, why: 'numeric literal' },
  { src: 'tokens.length === expectedLength', match: false, why: 'length compare — neither operand is the secret' },
  // ---- MUST NOT MATCH: real lines from api/ that the member-expression
  // arm must not sweep up. Each of these is a live source line today.
  { src: "const mcpTokenId = typeof raw.mcpTokenId === 'string' ? raw.mcpTokenId : ''", match: false, why: 'api/_oauth-token.js:79 — type check on a member expression' },
  { src: "if (typeof token !== 'string' || token.length === 0) return", match: false, why: 'api/_mcp-grant-hmac.ts:86 — type + length check' },
  { src: 'if (dot <= 0 || dot === token.length - 1) return', match: false, why: 'api/_mcp-grant-hmac.ts:88 — index compare against token.length' },
  { src: "if (err.code === 'missing_secret') return", match: false, why: "api/brief/…:167 — string literal that merely contains 'secret'" },
  { src: "if (action !== 'rotate-secret') return", match: false, why: 'api/v2/shipping/…:60 — action literal, not a secret value' },
  { src: "if (grantType === 'refresh_token') {", match: false, why: 'api/oauth/token.ts:725 — grant-type literal containing "token"' },
  { src: "if (action === 'create-pairing-token') {", match: false, why: 'api/notification-channels.ts:239 — action literal containing "token"' },
  { src: 'if (i !== tokens.length - 1) return null', match: false, why: 'api/_notification-webhook-ssrf.ts:60 — index compare' },
  // ---- MUST NOT MATCH: innocuous baseline.
  { src: 'const secret = "abc"', match: false, why: 'assignment, not comparison' },
  { src: 'if (status === 200) return', match: false, why: 'no secret operand' },
  { src: 'userInput !== sanitizedInput', match: false, why: 'no secret operand' },
  { src: 'return process.env.FOO', match: false, why: 'no comparison' },
  // ---- MUST MATCH: neutrally-named local vs a secret-NAMED env var. Neither
  // operand is a secret-named identifier, so the ident arms miss it entirely —
  // but reading a secret into `a` does not make comparing it safe.
  { src: 'if (a !== process.env.RELAY_SHARED_SECRET) return', match: true, why: 'neutral local vs secret-named env var' },
  { src: 'if (process.env.CRON_SECRET !== value) return', match: true, why: 'secret-named env var vs neutral local, reversed' },
  { src: 'if (headerValue === process.env.WM_API_TOKEN) return', match: true, why: 'neutral local vs secret-named env var' },
  // ---- MUST MATCH: inline header read, never bound to a variable. This is the
  // codebase's dominant header idiom, and #3803 itself was an x-probe-secret
  // header compare — a guard blind to this shape misses the likeliest recurrence.
  { src: "if (req.headers.get('x-probe-secret') !== expected) return", match: true, why: 'inline secret-named header read vs expected' },
  { src: "if (request.headers.get('x-relay-token') === process.env.FOO) return", match: true, why: 'inline secret-named header read vs env' },
  { src: "if (expected === req.headers.get('x-probe-secret')) return", match: true, why: 'inline chained header read, reversed' },
  { src: "if (process.env.FOO === request.headers.get('x-relay-token')) return", match: true, why: 'inline chained header read vs env, reversed' },
  // ---- MUST NOT MATCH: a NON-secret-named env var vs a neutral local must not
  // be swept up by the new env arm — that would flag ordinary config checks.
  { src: 'if (mode !== process.env.NODE_ENV) return', match: false, why: 'env var name is not secret-bearing' },
  { src: 'if (process.env.VERCEL_ENV === envName) return', match: false, why: 'env var name is not secret-bearing' },
  // ---- MUST NOT MATCH: a header read whose KEY is not secret-bearing.
  { src: "if (req.headers.get('content-type') !== expected) return", match: false, why: 'header key is not secret-bearing' },
  // ---- Comments are NOT stripped any more (the stripper deleted 30% of api/,
  // including real exported code, letting the scan pass vacuously — see the
  // planted-violation test below). Raw scanning is safe because these shapes are
  // not ones anyone writes in prose; a real prose hit would go to ALLOWLIST_FILES.
  { src: '// legacy: secret !== expectedSecret', match: true, why: 'raw scan: prose is matched too, deliberately' },
];

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
  it('the source walk includes every supported extension and excludes tests and generated trees', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'wm-secret-scan-walk-'));
    try {
      await Promise.all([
        mkdir(join(fixtureRoot, 'nested'), { recursive: true }),
        mkdir(join(fixtureRoot, 'node_modules'), { recursive: true }),
        mkdir(join(fixtureRoot, '.next'), { recursive: true }),
        mkdir(join(fixtureRoot, 'dist'), { recursive: true }),
      ]);

      const included = ['plain.ts', 'plain.js', 'plain.mjs', 'plain.cjs', 'nested/deep.ts'];
      const excluded = [
        'plain.test.ts',
        'plain.test.mjs',
        'plain.txt',
        'node_modules/vendor.ts',
        '.next/generated.js',
        'dist/bundle.cjs',
      ];
      await Promise.all(
        [...included, ...excluded].map(async (relativePath) => {
          const fullPath = join(fixtureRoot, relativePath);
          await writeFile(fullPath, '// fixture\n');
        }),
      );

      const actual = (await walk(fixtureRoot))
        .map((file) => file.slice(fixtureRoot.length + 1))
        .sort();
      assert.deepEqual(actual, [...included].sort());
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('no `<secretish> (===|!==) (process.env.* | expected* | <secretish>)` comparison exists in any api/ source', async () => {
    const files = await walk(apiDir);
    const violations: string[] = [];

    // See buildSecretComparePattern for the shapes this matches. The
    // meta-test below pins the full must-match / must-not-match table.
    const pattern = buildSecretComparePattern();

    for (const file of files) {
      const rel = file.slice(file.indexOf('/api/') + 1);
      if (ALLOWLIST_FILES.has(rel)) continue;
      const source = await readFile(file, 'utf8');
      if (pattern.test(normaliseForScan(source))) {
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

  it('the scan can actually FAIL — a violation planted in every real api/ file is caught', async () => {
    // This guard asserts an EMPTY list, so anything that quietly shrinks what it
    // reads produces a silent vacuous pass rather than a failure. That is not
    // hypothetical: this test previously ran `pattern.test(stripComments(source))`,
    // and the naive stripper deleted 30.2% of api/ by bytes — a glob like
    // `/*.openapi.json` inside a `//` comment reads as a block-comment OPENER and
    // ate 4160 bytes of api/mcp/types.ts including `export interface RpcToolDef`,
    // while `//` inside a URL literal truncated the rest of the line. A violation
    // landing in a swallowed region was invisible.
    //
    // Planting a known-bad line into EVERY file and requiring the scan to flag
    // every one of them makes that class of blindness impossible to reintroduce:
    // any future normalisation step that eats real code turns this test red.
    const pattern = buildSecretComparePattern();
    const files = await walk(apiDir);
    assert.ok(files.length > 50, `expected the api/ walk to find real files, got ${files.length}`);

    const VIOLATION = 'if (probeSecret !== expectedSecret) return unauthorized();';
    const missed: string[] = [];
    const shrunk: string[] = [];

    for (const file of files) {
      const rel = file.slice(file.indexOf('/api/') + 1);
      const source = await readFile(file, 'utf8');

      // (a) Nothing may DROP source. This is the direct statement of the property
      // the old stripper violated, and it fails on the first byte lost rather
      // than waiting for a violation to happen to land in a swallowed region.
      if (normaliseForScan(source).length !== source.length) shrunk.push(rel);

      // (b) A violation must be caught wherever it sits. Planted at three
      // positions — top, middle, bottom — because a swallowing normaliser eats a
      // REGION, not a whole file: appending only at the end would survive a
      // stripper that ate the middle, and the companion would stay green while
      // the real scan was blind. Each candidate goes through the SAME
      // normaliseForScan the real scan uses.
      const lines = source.split('\n');
      const mid = Math.floor(lines.length / 2);
      const candidates = [
        `${VIOLATION}\n${source}`,
        [...lines.slice(0, mid), VIOLATION, ...lines.slice(mid)].join('\n'),
        `${source}\n${VIOLATION}\n`,
      ];
      if (!candidates.every((c) => pattern.test(normaliseForScan(c)))) missed.push(rel);
    }

    assert.deepEqual(
      shrunk,
      [],
      `normaliseForScan DROPPED source for ${shrunk.length} file(s): ${shrunk.slice(0, 5).join(', ')}. ` +
        `Anything the scan cannot see, it cannot flag — this is how the guard silently stops working.`,
    );
    assert.deepEqual(
      missed,
      [],
      `The scan failed to detect a planted violation in ${missed.length} file(s): ${missed.slice(0, 5).join(', ')}. ` +
        `Something is dropping real source before the pattern runs — the guard is passing vacuously.`,
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

  it('meta: the source-grep regex matches exactly the intended shapes', () => {
    const pattern = buildSecretComparePattern();

    const failures: string[] = [];
    for (const { src, match, why } of PATTERN_CASES) {
      const actual = pattern.test(src);
      if (actual !== match) {
        failures.push(
          `  ${actual ? 'MATCHED but must not' : 'MISSED but must match'}: ${JSON.stringify(src)}  (${why})`,
        );
      }
    }

    assert.deepEqual(
      failures,
      [],
      `secret-compare pattern table mismatches:\n${failures.join('\n')}\n`,
    );
  });
});
