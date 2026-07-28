// Guard for #5767: importing a seeder module must never load production
// credentials into process.env.
//
// 149 seeder modules call `loadEnvFile(import.meta.url)` at module scope, and
// 103 of them are imported by at least one test. Before this guard, importing
// any of them populated process.env with every key in the developer's
// .env.local — Upstash Redis credentials included — so a test that touched any
// Redis code path operated against production.
//
// Two invariants are pinned here:
//   1. loadEnvFile() is inert under a test runtime (unless explicitly opted in).
//   2. loadEnvFile() never reaches outside the current checkout for credentials,
//      so worktree isolation actually isolates.
//
// Both are exercised against the REAL scripts/_seed-utils.mjs through a fixture
// checkout in a temp dir, so the assertions are meaningful in CI (which has no
// .env.local) as well as on developer machines. Deliberately no real seeder is
// imported here — that is its own repo landmine (top-level execution).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { glob } from 'node:fs/promises';

import { isTestRuntime } from '../scripts/_seed-utils.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEED_UTILS_URL = pathToFileURL(join(REPO_ROOT, 'scripts', '_seed-utils.mjs')).href;

const CHECKOUT_SENTINEL = 'https://checkout-local.invalid';
const ESCAPED_SENTINEL = 'https://escaped-home.invalid';
const EXPLICIT_SENTINEL = 'https://explicit-opt-in.invalid';

const envFileBody = (url) => `# fixture\nUPSTASH_REDIS_REST_URL=${url}\nUPSTASH_REDIS_REST_TOKEN=fixture-token\n`;

/**
 * Build a throwaway checkout shaped like the real repo: `<root>/scripts/` next
 * to an optional `<root>/.env.local`, plus a fake `$HOME` that always contains
 * the hardcoded `Documents/GitHub/worldmonitor/.env.local` the old candidate
 * list reached for.
 */
function makeFixtureCheckout({ withLocalEnvFile }) {
  const root = mkdtempSync(join(tmpdir(), 'wm-seed-env-'));
  mkdirSync(join(root, 'scripts'));

  if (withLocalEnvFile) {
    writeFileSync(join(root, '.env.local'), envFileBody(CHECKOUT_SENTINEL));
  }

  const fakeHome = join(root, 'fake-home');
  const escapedDir = join(fakeHome, 'Documents/GitHub/worldmonitor');
  mkdirSync(escapedDir, { recursive: true });
  writeFileSync(join(escapedDir, '.env.local'), envFileBody(ESCAPED_SENTINEL));

  writeFileSync(
    join(root, 'scripts', 'fixture-seeder.mjs'),
    [
      `import { loadEnvFile } from ${JSON.stringify(SEED_UTILS_URL)};`,
      'loadEnvFile(import.meta.url);',
      'process.stdout.write(`__RESULT__${JSON.stringify({',
      '  url: process.env.UPSTASH_REDIS_REST_URL ?? null,',
      '  token: process.env.UPSTASH_REDIS_REST_TOKEN ?? null,',
      '})}`);',
      '',
    ].join('\n'),
  );

  return { root, fakeHome };
}

/**
 * Run the fixture module in a clean child process — no inherited UPSTASH_* and
 * no inherited NODE_TEST_CONTEXT — and report what loadEnvFile() put in env.
 */
function runFixture({ root, fakeHome }, extraEnv = {}) {
  const stdout = execFileSync(process.execPath, [join(root, 'scripts', 'fixture-seeder.mjs')], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: fakeHome, ...extraEnv },
  });
  const marker = stdout.lastIndexOf('__RESULT__');
  assert.notEqual(marker, -1, `fixture produced no result marker:\n${stdout}`);
  return JSON.parse(stdout.slice(marker + '__RESULT__'.length));
}

/**
 * Pure predicate: does this source text resolve a credential file from outside
 * the checkout it lives in? Kept as a data-in/data-out function so the truth
 * table below can prove it has teeth, rather than trusting a bare repo grep.
 */
function findCheckoutEscapingEnvPaths(source) {
  const offenders = [];
  // An absolute path into somebody's home directory, baked into the repo. This
  // shape IS reliably regex-detectable — the literal has to appear verbatim.
  for (const match of source.matchAll(/['"`](\/(?:Users|home)\/[^'"`\n]+)['"`]/g)) {
    offenders.push(match[1]);
  }
  return offenders;
}

// Every way a script can learn where the user's home directory is. Matching the
// SOURCE rather than the assembled path is what makes this alias-proof: the
// earlier version keyed on `join(process.env.HOME, 'Documents/...')` and was
// trivially evaded by `process.env['HOME']`, a `homedir as getHome` alias, a
// template literal, or plain concatenation — all five went green against the
// verbatim #5767 bug. A path still has to come from one of these names.
const HOME_DIR_SOURCES = [
  [/\bhomedir\b/, 'os.homedir (including an aliased import)'],
  [/process\.env\.HOME\b/, 'process.env.HOME'],
  [/process\.env\[\s*['"`]HOME['"`]\s*\]/, "process.env['HOME']"],
  [/process\.env\.(?:USERPROFILE|HOMEPATH|HOMEDRIVE)\b/, 'Windows home env var'],
  [
    /process\.env\[\s*['"`](?:USERPROFILE|HOMEPATH|HOMEDRIVE)['"`]\s*\]/,
    'Windows home env var (bracket)',
  ],
  [/['"`]~\//, 'a literal ~/ path'],
];

/**
 * Pure predicate: does this source reach for the user's home directory at all?
 * Only meaningful when applied to a file that also parses a `.env` file — a
 * script may legitimately use homedir() for a cache path.
 */
function findHomeDirReferences(source) {
  return HOME_DIR_SOURCES.filter(([re]) => re.test(source)).map(([, label]) => label);
}

// Files under scripts/ allowed to parse a .env file into process.env themselves.
// Every other script must route through the shared `loadEnvFile`, which is where
// the test-runtime and checkout-scoping rules live — a private copy of the parser
// silently opts out of both, which is how #5767's second instance survived.
const ENV_PARSER_ALLOWLIST = new Set([
  // The one implementation.
  'scripts/_seed-utils.mjs',
  // Deliberately narrower than the shared helper: hydrates only the two Upstash
  // keys it needs rather than bulk-importing every var, and is main()-scoped.
  'scripts/shadow-score-report.mjs',
]);

/**
 * Pure predicate: does this source parse a `.env` file into `process.env` itself?
 * Keyed on the two halves that must both be present — reading a `.env` path and
 * writing a computed key into `process.env` — so merely mentioning `.env.local`
 * in a comment, or symlinking it (bootstrap-worktree.mjs), does not trip it.
 */
function parsesEnvFileItself(source) {
  const readsEnvFile = /['"`][^'"`\n]*\.env(?:\.local)?['"`]/.test(source);
  // `[^\n]*?` rather than `[^\]]+` so a nested subscript still matches — the real
  // loaders write `process.env[m[1]] = m[2]`, which a bracket-excluding class
  // silently skips. The trailing `[^=]` keeps `===` comparisons out.
  const writesComputedEnvKey = /process\.env\[[^\n]*?\]\s*=[^=]/.test(source);
  return readsEnvFile && writesComputedEnvKey;
}

describe('seeder env hermeticity (#5767)', () => {
  describe('isTestRuntime()', () => {
    it('detects the runners that import seeder modules', () => {
      const cases = [
        [{ NODE_TEST_CONTEXT: 'child-v8' }, true, 'node:test child process'],
        [{ NODE_TEST_CONTEXT: 'child' }, true, 'node:test child process (json)'],
        [{ VITEST: 'true' }, true, 'vitest'],
        [{ VITEST_WORKER_ID: '3' }, true, 'vitest worker'],
        [{ JEST_WORKER_ID: '1' }, true, 'jest worker'],
        [{ NODE_ENV: 'test' }, true, 'NODE_ENV=test'],
        [{}, false, 'plain node process'],
        [{ NODE_ENV: 'production' }, false, 'production'],
        [{ NODE_TEST_CONTEXT: '' }, false, 'empty marker is not a test runtime'],
      ];
      for (const [env, expected, label] of cases) {
        assert.equal(isTestRuntime(env), expected, label);
      }
    });

    it('reads process.env by default', () => {
      // This suite itself runs under node:test, so the default must be `true`.
      assert.equal(isTestRuntime(), true);
    });
  });

  describe('loadEnvFile() against a fixture checkout', () => {
    it('loads the checkout-local .env.local when a seeder is actually run', () => {
      const fixture = makeFixtureCheckout({ withLocalEnvFile: true });
      const result = runFixture(fixture);
      assert.equal(result.url, CHECKOUT_SENTINEL);
      assert.equal(result.token, 'fixture-token');
    });

    it('loads nothing when the process is a node:test runtime', () => {
      const fixture = makeFixtureCheckout({ withLocalEnvFile: true });
      const result = runFixture(fixture, { NODE_TEST_CONTEXT: 'child-v8' });
      assert.equal(result.url, null, 'credentials must not reach a test process');
      assert.equal(result.token, null);
    });

    it('loads nothing when the process is a vitest runtime', () => {
      const fixture = makeFixtureCheckout({ withLocalEnvFile: true });
      const result = runFixture(fixture, { VITEST: 'true' });
      assert.equal(result.url, null);
      assert.equal(result.token, null);
    });

    it('still loads under a test runtime when explicitly opted in', () => {
      const fixture = makeFixtureCheckout({ withLocalEnvFile: true });
      const result = runFixture(fixture, {
        NODE_TEST_CONTEXT: 'child-v8',
        WM_ALLOW_ENV_LOAD_IN_TESTS: '1',
      });
      assert.equal(result.url, CHECKOUT_SENTINEL, 'escape hatch must still work');
    });

    it('never reaches into $HOME/Documents/GitHub/worldmonitor for credentials', () => {
      // The checkout has no .env.local of its own — exactly the worktree case
      // from #5767. The fake $HOME does have one; it must not be found.
      const fixture = makeFixtureCheckout({ withLocalEnvFile: false });
      const result = runFixture(fixture);
      assert.equal(result.url, null, 'loadEnvFile escaped the checkout via $HOME');
      assert.equal(result.token, null);
    });

    it('honours an explicit WM_SEED_ENV_FILE path', () => {
      const fixture = makeFixtureCheckout({ withLocalEnvFile: false });
      const explicit = join(fixture.root, 'explicit.env');
      writeFileSync(explicit, envFileBody(EXPLICIT_SENTINEL));
      const result = runFixture(fixture, { WM_SEED_ENV_FILE: explicit });
      assert.equal(result.url, EXPLICIT_SENTINEL);
    });

    it('falls through to the checkout when WM_SEED_ENV_FILE does not exist', () => {
      // The candidate loop skips a missing path silently, so a typo degrades to
      // the checkout-local file rather than failing loudly. Pinning the
      // behaviour either way so a refactor cannot change it unnoticed.
      const fixture = makeFixtureCheckout({ withLocalEnvFile: true });
      const result = runFixture(fixture, {
        WM_SEED_ENV_FILE: join(fixture.root, 'does-not-exist.env'),
      });
      assert.equal(result.url, CHECKOUT_SENTINEL);
    });

    it('only accepts the exact opt-in value', () => {
      const fixture = makeFixtureCheckout({ withLocalEnvFile: true });
      for (const value of ['true', 'yes', '0', '']) {
        const result = runFixture(fixture, {
          NODE_TEST_CONTEXT: 'child-v8',
          WM_ALLOW_ENV_LOAD_IN_TESTS: value,
        });
        assert.equal(result.url, null, `WM_ALLOW_ENV_LOAD_IN_TESTS=${JSON.stringify(value)}`);
      }
    });

    it('ignores WM_SEED_ENV_FILE under a test runtime', () => {
      const fixture = makeFixtureCheckout({ withLocalEnvFile: false });
      const explicit = join(fixture.root, 'explicit.env');
      writeFileSync(explicit, envFileBody(EXPLICIT_SENTINEL));
      const result = runFixture(fixture, {
        WM_SEED_ENV_FILE: explicit,
        NODE_TEST_CONTEXT: 'child-v8',
      });
      assert.equal(result.url, null, 'the opt-in path must not defeat test hermeticity');
    });
  });

  describe('no script resolves credentials from outside its checkout', () => {
    it('findCheckoutEscapingEnvPaths flags a home path baked into the repo', () => {
      assert.deepEqual(
        findCheckoutEscapingEnvPaths(`envPath = join('/Users/someone/Documents/GitHub/worldmonitor', '.env.local');`),
        ['/Users/someone/Documents/GitHub/worldmonitor'],
      );
      assert.deepEqual(
        findCheckoutEscapingEnvPaths(`const p = '/home/ci/worldmonitor/.env.local';`),
        ['/home/ci/worldmonitor/.env.local'],
      );
      // Negatives: checkout-relative and explicitly-configured paths are fine.
      assert.deepEqual(findCheckoutEscapingEnvPaths(`join(__dirname, '..', '.env.local')`), []);
      assert.deepEqual(findCheckoutEscapingEnvPaths(`process.env.WM_SEED_ENV_FILE`), []);
    });

    it('findHomeDirReferences survives every rewrite of the #5767 escape', () => {
      // Each of these is the same bug in a different costume, and each one
      // defeated the previous `join(process.env.HOME, '<literal>')` regex.
      const disguises = [
        `join(process.env.HOME, 'Documents/GitHub/worldmonitor', '.env.local')`,
        `join(process.env['HOME'], 'Documents/GitHub/worldmonitor', '.env.local')`,
        `import { homedir as getHome } from 'node:os';\nconst p = join(getHome(), 'wm/.env.local');`,
        'const p = `${process.env.HOME}/Documents/GitHub/worldmonitor/.env.local`;',
        `const p = process.env.HOME + '/Documents/GitHub/worldmonitor/.env.local';`,
        `const p = join(process.env.USERPROFILE, 'wm', '.env.local');`,
        `const p = '~/Documents/GitHub/worldmonitor/.env.local';`,
      ];
      for (const source of disguises) {
        assert.ok(
          findHomeDirReferences(source).length > 0,
          `home-directory escape went undetected:\n${source}`,
        );
      }
      // Negative: nothing here reaches for a home directory.
      assert.deepEqual(findHomeDirReferences(`join(__dirname, '..', '.env.local')`), []);
    });

    it('no script bakes a home path into the repo', async () => {
      const offenders = [];
      let scanned = 0;
      for await (const entry of glob('scripts/**/*.{mjs,cjs,js}', { cwd: REPO_ROOT })) {
        if (entry.includes('node_modules')) continue;
        scanned += 1;
        const found = findCheckoutEscapingEnvPaths(readFileSync(join(REPO_ROOT, entry), 'utf8'));
        if (found.length > 0) offenders.push(`${entry}: ${found.join(', ')}`);
      }
      assert.ok(scanned > 100, `expected to scan the seeder fleet, scanned ${scanned}`);
      assert.deepEqual(offenders, [], `scripts with a hardcoded home path:\n${offenders.join('\n')}`);
    });

    it('no .env parser reaches for a home directory', async () => {
      // Scoped to the files that parse .env at all, which the sweep below pins
      // to the allowlist. Any NEW file that escapes to $HOME for credentials
      // must parse .env to use them, so it is caught there first and here
      // second — the two sweeps close each other's gap.
      const offenders = [];
      for await (const entry of glob('scripts/**/*.{mjs,cjs,js}', { cwd: REPO_ROOT })) {
        if (entry.includes('node_modules')) continue;
        const source = readFileSync(join(REPO_ROOT, entry), 'utf8');
        if (!parsesEnvFileItself(source)) continue;
        const found = findHomeDirReferences(source);
        if (found.length > 0) offenders.push(`${entry}: ${found.join(', ')}`);
      }
      assert.deepEqual(
        offenders,
        [],
        `these resolve credentials from the home directory, defeating worktree ` +
          `isolation:\n${offenders.join('\n')}`,
      );
    });
  });

  describe('only the shared helper parses .env files', () => {
    it('parsesEnvFileItself needs both halves — a read AND a computed process.env write', () => {
      assert.equal(
        parsesEnvFileItself(`const p = join(root, '.env.local');\nprocess.env[key] = val;`),
        true,
      );
      assert.equal(
        // The shape both real loaders use — a nested subscript on the left.
        parsesEnvFileItself(
          `readFileSync('.env.local');\nif (!process.env[m[1]]) process.env[m[1]] = m[2];`,
        ),
        true,
        'a nested subscript must not evade the guard',
      );
      assert.equal(
        parsesEnvFileItself(`const p = '.env.local';\nif (process.env[key] === val) return;`),
        false,
        'a comparison is not a write',
      );
      // Negatives: each half alone, and the shapes that legitimately touch either.
      assert.equal(parsesEnvFileItself(`// documented in .env.local`), false, 'comment only');
      assert.equal(parsesEnvFileItself(`process.env[key] = val;`), false, 'no env file read');
      assert.equal(
        parsesEnvFileItself(`symlinkSync(join(src, '.env.local'), dest);`),
        false,
        'symlinking an env file is not parsing it',
      );
      assert.equal(
        parsesEnvFileItself(`const p = '.env.local';\nprocess.env.FOO = 'bar';`),
        false,
        'a fixed-key write is not a bulk import',
      );
    });

    it('no script under scripts/ re-implements the loader', async () => {
      const offenders = [];
      for await (const entry of glob('scripts/**/*.{mjs,cjs,js}', { cwd: REPO_ROOT })) {
        if (entry.includes('node_modules') || ENV_PARSER_ALLOWLIST.has(entry)) continue;
        if (parsesEnvFileItself(readFileSync(join(REPO_ROOT, entry), 'utf8'))) offenders.push(entry);
      }
      assert.deepEqual(
        offenders,
        [],
        `these parse .env themselves instead of calling loadEnvFile(), so they bypass the ` +
          `test-runtime guard entirely:\n${offenders.join('\n')}`,
      );
    });

    it('the allowlist has no stale entries', async () => {
      for (const entry of ENV_PARSER_ALLOWLIST) {
        assert.ok(
          parsesEnvFileItself(readFileSync(join(REPO_ROOT, entry), 'utf8')),
          `${entry} no longer parses .env itself — drop it from ENV_PARSER_ALLOWLIST`,
        );
      }
    });
  });
});
