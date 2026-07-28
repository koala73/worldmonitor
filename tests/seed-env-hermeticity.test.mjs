// Guard for #5767: importing a seeder module must never load production
// credentials into process.env.
//
// 149 seeder modules call `loadEnvFile(import.meta.url)` at module scope, and
// 103 of them are imported by at least one test. Before this guard, importing
// any of them populated process.env with every key in the developer's
// .env.local — Upstash Redis credentials included — so a test that touched any
// Redis code path operated against production.
//
// Three invariants are pinned here:
//   1. loadEnvFile() is inert under a test runtime (unless explicitly opted in).
//   2. loadEnvFile() never reaches outside the current checkout for credentials
//      — not into $HOME, and not into the directory next to the checkout. Note
//      this alone does NOT make a worktree credential-isolated: worktree:bootstrap
//      symlinks the source checkout's .env.local in, so a seeder RUN there still
//      sees production. Invariant 1 is what protects test processes.
//   3. loadEnvFile() is the ONLY thing that loads a .env file. A private copy of
//      the loader opts out of 1 and 2 silently, which is exactly how the second
//      instance of this bug survived in fetch-pizzint-bases.mjs.
//
// 1 and 2 are exercised against the REAL scripts/_seed-utils.mjs through a
// fixture checkout in a temp dir, so the assertions are meaningful in CI (which
// has no .env.local) as well as on developer machines. Deliberately no real
// seeder is imported — that is its own repo landmine (top-level execution) — so
// invariant 3 is what closes the gap between "the helper is hermetic" and "every
// seeder is hermetic".
//
// The source sweeps for 3 are written to survive rewording, because an earlier
// version of this file did not: keying on `join(process.env.HOME, '<literal>')`
// and on `process.env[key] = value` let bracket notation, an aliased homedir
// import, a template literal, string concatenation, Object.assign, Reflect.set,
// process.loadEnvFile and a fixed-key write all through with working leaks.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { glob } from 'node:fs/promises';

import { isTestRuntime } from '../scripts/_seed-utils.mjs';
import { stripJsComments } from '../scripts/lib/js-source-structure.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEED_UTILS_URL = pathToFileURL(join(REPO_ROOT, 'scripts', '_seed-utils.mjs')).href;

const CHECKOUT_SENTINEL = 'https://checkout-local.invalid';
const ESCAPED_SENTINEL = 'https://escaped-home.invalid';
const EXPLICIT_SENTINEL = 'https://explicit-opt-in.invalid';
const PARENT_SENTINEL = 'https://parent-of-checkout.invalid';

const envFileBody = (url) => `# fixture\nUPSTASH_REDIS_REST_URL=${url}\nUPSTASH_REDIS_REST_TOKEN=fixture-token\n`;

/**
 * Build a throwaway checkout shaped like the real repo: `<root>/scripts/` next
 * to an optional `<root>/.env.local`, plus a fake `$HOME` that always contains
 * the hardcoded `Documents/GitHub/worldmonitor/.env.local` the old candidate
 * list reached for.
 */
function makeFixtureCheckout({ withLocalEnvFile, nested = false, only = null }) {
  const outer = mkdtempSync(join(tmpdir(), 'wm-seed-env-'));
  // The fixture checkout sits INSIDE a temp dir that also holds a .env.local,
  // so every case doubles as a check that resolution stops at the checkout
  // boundary. `loadEnvFile` used to probe `<checkout>/../.env.local` and really
  // did read this one.
  writeFileSync(join(outer, '.env.local'), envFileBody(PARENT_SENTINEL));

  const root = join(outer, 'checkout');
  const scriptDir = nested ? join(root, 'scripts', 'nested') : join(root, 'scripts');
  mkdirSync(scriptDir, { recursive: true });
  // Marks the checkout boundary the same way a worktree does — a `.git` file.
  writeFileSync(join(root, '.git'), 'gitdir: /nowhere\n');

  if (withLocalEnvFile) {
    writeFileSync(join(root, '.env.local'), envFileBody(CHECKOUT_SENTINEL));
  }

  const fakeHome = join(root, 'fake-home');
  const escapedDir = join(fakeHome, 'Documents/GitHub/worldmonitor');
  mkdirSync(escapedDir, { recursive: true });
  writeFileSync(join(escapedDir, '.env.local'), envFileBody(ESCAPED_SENTINEL));

  writeFileSync(
    join(scriptDir, 'fixture-seeder.mjs'),
    [
      `import { loadEnvFile } from ${JSON.stringify(SEED_UTILS_URL)};`,
      `loadEnvFile(import.meta.url${only ? `, { only: ${JSON.stringify(only)} }` : ''});`,
      'process.stdout.write(`__RESULT__${JSON.stringify({',
      '  url: process.env.UPSTASH_REDIS_REST_URL ?? null,',
      '  token: process.env.UPSTASH_REDIS_REST_TOKEN ?? null,',
      '})}`);',
      '',
    ].join('\n'),
  );

  return { root, fakeHome, entry: join(scriptDir, 'fixture-seeder.mjs') };
}

/**
 * Run the fixture module in a clean child process — no inherited UPSTASH_* and
 * no inherited NODE_TEST_CONTEXT — and report what loadEnvFile() put in env.
 */
function runFixture({ entry, fakeHome }, extraEnv = {}) {
  const stdout = execFileSync(process.execPath, [entry], {
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

// Every tree that can reach a seeder or run server-side. Wider than scripts/ on
// purpose: a loader in api/ or cli/ leaks exactly the same credentials, and the
// sweeps cost nothing to extend.
const SCANNED_TREES = ['scripts', 'api', 'server', 'cli', 'middleware.ts'];

async function* scanSources() {
  for (const tree of SCANNED_TREES) {
    const pattern = tree.includes('.') ? tree : `${tree}/**/*.{mjs,cjs,js,mts,ts}`;
    for await (const entry of glob(pattern, { cwd: REPO_ROOT })) {
      if (entry.includes('node_modules')) continue;
      yield entry;
    }
  }
}

// Files allowed to name a `.env` path directly. Everything else must route
// through the shared `loadEnvFile`, which is where the test-runtime and
// checkout-scoping rules live — a private copy of the loader silently opts out
// of both, which is how #5767's second instance survived in fetch-pizzint-bases.
const ENV_PARSER_ALLOWLIST = new Set([
  // The one implementation. Nothing else — shadow-score-report.mjs used to be
  // here too, exempted on the claim that it was main()-scoped; it is a bare
  // top-level IIFE with no direct-run guard, so importing it loaded credentials
  // at module scope with no isTestRuntime() check. It now takes the shared
  // helper's `only` option instead, which keeps its 2-key narrowing.
  'scripts/_seed-utils.mjs',
]);

// Every way a script can get at a `.env` file's contents.
const ENV_FILE_ACCESS = [
  // Naming the file. Unavoidable for any hand-rolled loader, whatever it does
  // with the contents afterwards.
  [/['"`][^'"`\n]*\.env(?:\.[A-Za-z0-9_-]+)?['"`]/, 'a .env path'],
  // Node's built-in parser, which needs no path at all (defaults to ./.env).
  [/\bprocess\.loadEnvFile\b/, 'process.loadEnvFile()'],
  [/\bloadEnvFile\s*\(\s*\)/, 'a no-arg loadEnvFile()'],
  // Third-party loaders.
  [/['"`]dotenv(?:\/[^'"`]*)?['"`]/, 'dotenv'],
  [/\bdotenv\s*\.\s*config\b/, 'dotenv.config()'],
];

// Every way a script can get parsed values INTO process.env. The earlier
// version of this guard listed only `process.env[key] = value`, which made it
// hostage to the write primitive: `Object.assign(process.env, parsed)`,
// `process.loadEnvFile(p)`, `dotenv.config()`, `Reflect.set(process.env, ...)`
// and a plain fixed-key assignment each carried a working leak straight past it.
const ENV_WRITE_PRIMITIVES = [
  [/process\.env\[[^\n]*?\]\s*=[^=]/, 'a computed process.env subscript'],
  [/process\.env\.[A-Za-z_$][\w$]*\s*=[^=]/, 'a fixed process.env key'],
  [/Object\.(?:assign|defineProperty|defineProperties)\s*\(\s*process\.env\b/, 'Object.assign'],
  [/Reflect\.set\s*\(\s*process\.env\b/, 'Reflect.set'],
  // These both read and write in one call, so they satisfy either half.
  [/\bprocess\.loadEnvFile\b/, 'process.loadEnvFile()'],
  [/\bdotenv\s*\.\s*config\b/, 'dotenv.config()'],
  [/['"`]dotenv(?:\/[^'"`]*)?['"`]/, 'dotenv'],
];

/**
 * Pure predicate: does this source load a `.env` file into `process.env` itself?
 *
 * Both halves are required, and both are matched broadly. The read half is
 * effectively unavoidable — to load a `.env` file you must name it or call a
 * loader that is itself named. The write half is what the previous version got
 * wrong by enumerating one primitive; it now covers the bulk and fixed-key
 * forms too.
 *
 * Requiring the write half is what keeps the legitimate `.env` *scanners*
 * (check-vite-env-secrets, check-local-secret-dumps, the provenance generator)
 * out of the offender list without an allowlist entry each: they read env files
 * to audit them and never put anything into process.env.
 *
 * Comments are blanked first (the repo's own scanner) so a file that merely
 * documents `.env.local` is not an offender.
 *
 * Known residual: a deliberate split across two files — one naming the path,
 * another doing the write — evades a per-file predicate. That is obfuscation,
 * not the accidental copy-paste this guards against.
 */
function accessesEnvFileItself(source) {
  const code = stripJsComments(source);
  const reads = ENV_FILE_ACCESS.some(([re]) => re.test(code));
  const writes = ENV_WRITE_PRIMITIVES.some(([re]) => re.test(code));
  return reads && writes;
}

describe('seeder env hermeticity (#5767)', () => {
  describe('isTestRuntime()', () => {
    it('detects the runners that import seeder modules', () => {
      const cases = [
        [{ NODE_TEST_CONTEXT: 'child-v8' }, true, 'node:test child process'],
        [{ NODE_TEST_CONTEXT: 'child' }, true, 'node:test child process (json)'],
        [{ VITEST: 'true' }, true, 'vitest'],
        [{ VITEST_WORKER_ID: '3' }, true, 'vitest worker'],
        // The value vitest actually uses for its first worker. Pinned because a
        // refactor to a truthiness check would keep every other case green.
        [{ VITEST_WORKER_ID: '0' }, true, 'vitest worker zero'],
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

    it('the opt-in is not set in the process actually running the suite', () => {
      // Every other case here runs in a child process built from a scrubbed
      // env, so nothing else observes the process the real suite runs in. One
      // stray `export WM_ALLOW_ENV_LOAD_IN_TESTS=1` disables the fix for all
      // 16k+ tests at once and every other assertion stays green.
      assert.notEqual(
        process.env.WM_ALLOW_ENV_LOAD_IN_TESTS,
        '1',
        'WM_ALLOW_ENV_LOAD_IN_TESTS=1 is set in this environment — seeder imports ' +
          'are loading real credentials into every test in this run',
      );
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

    it('honours the `only` key filter', () => {
      // shadow-score-report.mjs needs exactly two keys, not the whole file. It
      // used to get that with a private loader, which is how it stayed outside
      // the test-runtime guard; `only` is what let it drop the private copy.
      const fixture = makeFixtureCheckout({
        withLocalEnvFile: true,
        only: ['UPSTASH_REDIS_REST_URL'],
      });
      const result = runFixture(fixture);
      assert.equal(result.url, CHECKOUT_SENTINEL, 'the requested key must load');
      assert.equal(result.token, null, '`only` must exclude every other key');
    });

    it('applies the test-runtime guard to `only` callers too', () => {
      const fixture = makeFixtureCheckout({
        withLocalEnvFile: true,
        only: ['UPSTASH_REDIS_REST_URL'],
      });
      const result = runFixture(fixture, { NODE_TEST_CONTEXT: 'child-v8' });
      assert.equal(result.url, null);
    });

    it('never reads the .env.local sitting next to the checkout', () => {
      // The checkout has no .env.local; its PARENT does. `loadEnvFile` probed
      // `<checkout>/../.env.local`, so it read that one and the suite still
      // called itself hermetic.
      const fixture = makeFixtureCheckout({ withLocalEnvFile: false });
      const result = runFixture(fixture);
      assert.equal(result.url, null, 'loadEnvFile escaped into the parent directory');
    });

    it('resolves the checkout root from a nested script directory', () => {
      // The depth the removed `../..` candidate existed to serve. Anchoring to
      // the checkout root has to handle it without reintroducing the escape,
      // and the parent .env.local must still lose.
      const fixture = makeFixtureCheckout({ withLocalEnvFile: true, nested: true });
      const result = runFixture(fixture);
      assert.equal(result.url, CHECKOUT_SENTINEL);
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

    it('no source bakes a home path into the repo', async () => {
      const offenders = [];
      let scanned = 0;
      for await (const entry of scanSources()) {
        scanned += 1;
        const found = findCheckoutEscapingEnvPaths(readFileSync(join(REPO_ROOT, entry), 'utf8'));
        if (found.length > 0) offenders.push(`${entry}: ${found.join(', ')}`);
      }
      assert.ok(scanned > 100, `expected to scan the seeder fleet, scanned ${scanned}`);
      assert.deepEqual(offenders, [], `sources with a hardcoded home path:\n${offenders.join('\n')}`);
    });

    it('no env-loading source reaches for a home directory', async () => {
      // Gated on accessesEnvFileItself, NOT on the write-half predicate this
      // used to use. Under the old gating, escaping the parser check also
      // switched this one off — so a file doing plain `homedir()` +
      // `process.loadEnvFile()` passed BOTH sweeps with a working leak. The
      // read-half gate has no such bypass: naming a `.env` file (or a loader)
      // is unavoidable, so anything reaching for $HOME to find one lands here.
      const offenders = [];
      for await (const entry of scanSources()) {
        const source = readFileSync(join(REPO_ROOT, entry), 'utf8');
        if (!accessesEnvFileItself(source)) continue;
        const found = findHomeDirReferences(stripJsComments(source));
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

  describe('only the shared helper reads .env files', () => {
    it('accessesEnvFileItself catches every write primitive, not just a computed subscript', () => {
      // The write half is unconstrained — each of these is a working bulk load
      // and every one of them defeated the earlier `process.env[k] = v` gate.
      const loaders = [
        `const p = join(root, '.env.local');\nprocess.env[key] = val;`,
        `const parsed = parse(readFileSync('.env.local'));\nObject.assign(process.env, parsed);`,
        `process.loadEnvFile(join(root, '.env.local'));`,
        `process.loadEnvFile();`,
        `import 'dotenv/config';`,
        `dotenv.config({ path: p });`,
        `Reflect.set(process.env, k, v); readFileSync('.env.local');`,
        `readFileSync('.env.local');\nprocess.env.UPSTASH_REDIS_REST_URL = m[2];`,
      ];
      for (const source of loaders) {
        assert.ok(accessesEnvFileItself(source), `env loader went undetected:\n${source}`);
      }
      // Negatives: documenting or symlinking an env file is not reading one.
      assert.equal(accessesEnvFileItself(`// documented in .env.local`), false, 'line comment');
      assert.equal(
        accessesEnvFileItself(`/*\n * Reads .env.local at project root.\n */\nconst x = 1;`),
        false,
        'block comment',
      );
      assert.equal(accessesEnvFileItself(`process.env[key] = val;`), false, 'no env file read');
      assert.equal(
        accessesEnvFileItself(`symlinkSync(join(src, '.env.local'), dest);`),
        false,
        'symlinking an env file is not loading it',
      );
      assert.equal(
        // The scanners: they read env files to audit them, never to apply them.
        accessesEnvFileItself(`const body = readFileSync('.env.local', 'utf8');\nreturn findSecrets(body);`),
        false,
        'auditing an env file is not loading it',
      );
    });

    it('no source outside the allowlist reads a .env file', async () => {
      const offenders = [];
      for await (const entry of scanSources()) {
        if (ENV_PARSER_ALLOWLIST.has(entry)) continue;
        if (accessesEnvFileItself(readFileSync(join(REPO_ROOT, entry), 'utf8'))) offenders.push(entry);
      }
      assert.deepEqual(
        offenders,
        [],
        `these read .env themselves instead of calling loadEnvFile(), so they bypass the ` +
          `test-runtime guard entirely:\n${offenders.join('\n')}`,
      );
    });

    it('the allowlist has no stale entries', async () => {
      for (const entry of ENV_PARSER_ALLOWLIST) {
        assert.ok(
          accessesEnvFileItself(readFileSync(join(REPO_ROOT, entry), 'utf8')),
          `${entry} no longer reads .env itself — drop it from ENV_PARSER_ALLOWLIST`,
        );
      }
    });
  });
});
