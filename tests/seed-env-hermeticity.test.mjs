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
  // An absolute path into somebody's home directory, baked into the repo.
  for (const match of source.matchAll(/['"`](\/(?:Users|home)\/[^'"`\n]+)['"`]/g)) {
    offenders.push(match[1]);
  }
  // $HOME (or os.homedir()) joined with a checkout-shaped path — reaches out of
  // whichever worktree the script actually lives in.
  for (const match of source.matchAll(
    /(?:process\.env\.HOME|homedir\(\))\s*,\s*['"`]([^'"`\n]*(?:GitHub|Documents|worldmonitor)[^'"`\n]*)['"`]/g,
  )) {
    offenders.push(match[1]);
  }
  return offenders;
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
    it('findCheckoutEscapingEnvPaths flags the shapes that broke worktree isolation', () => {
      assert.deepEqual(
        findCheckoutEscapingEnvPaths(`envPath = join('/Users/someone/Documents/GitHub/worldmonitor', '.env.local');`),
        ['/Users/someone/Documents/GitHub/worldmonitor'],
      );
      assert.deepEqual(
        findCheckoutEscapingEnvPaths(`candidates.push(join(process.env.HOME, 'Documents/GitHub/worldmonitor', '.env.local'));`),
        ['Documents/GitHub/worldmonitor'],
      );
      assert.deepEqual(
        findCheckoutEscapingEnvPaths(`const p = join(homedir(), 'Documents/GitHub/worldmonitor');`),
        ['Documents/GitHub/worldmonitor'],
      );
      // Negatives: checkout-relative and explicitly-configured paths are fine.
      assert.deepEqual(findCheckoutEscapingEnvPaths(`join(__dirname, '..', '.env.local')`), []);
      assert.deepEqual(findCheckoutEscapingEnvPaths(`process.env.WM_SEED_ENV_FILE`), []);
      assert.deepEqual(findCheckoutEscapingEnvPaths(`join(process.env.HOME, '.cache')`), []);
    });

    it('finds no offenders anywhere under scripts/', async () => {
      const offenders = [];
      let scanned = 0;
      for await (const entry of glob('scripts/**/*.{mjs,cjs,js}', { cwd: REPO_ROOT })) {
        if (entry.includes('node_modules')) continue;
        scanned += 1;
        const found = findCheckoutEscapingEnvPaths(readFileSync(join(REPO_ROOT, entry), 'utf8'));
        if (found.length > 0) offenders.push(`${entry}: ${found.join(', ')}`);
      }
      assert.ok(scanned > 100, `expected to scan the seeder fleet, scanned ${scanned}`);
      assert.deepEqual(offenders, [], `scripts reaching outside the checkout:\n${offenders.join('\n')}`);
    });
  });
});
