// Credential loading for every scripts/ entry point. Leaf module on purpose:
// it imports nothing of its own, so a container that only needs .env.local
// handling ships this one file and not the Redis seed kernel in _seed-utils.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Env vars set by the runners that import seeder modules without running them.
// 149 seeders call loadEnvFile() at module scope, so under one of these the
// import alone would hand production credentials to the test process (#5767).
// Known gap: `node --test --experimental-test-isolation=none` runs tests in the
// main process and sets NO marker at all. The repo uses that flag nowhere, but
// adding it would disable this guard for the whole suite in one edit.
const TEST_RUNTIME_MARKERS = [
  'NODE_TEST_CONTEXT', // node --test and tsx --test
  'VITEST',
  'VITEST_WORKER_ID',
  'JEST_WORKER_ID',
  'PLAYWRIGHT_TEST_BASE_URL', // playwright sets neither NODE_ENV nor a generic marker
  'PW_TEST_SOURCE_LOCATION',
];

export function isTestRuntime(env = process.env) {
  if (env.NODE_ENV === 'test') return true;
  return TEST_RUNTIME_MARKERS.some((key) => typeof env[key] === 'string' && env[key] !== '');
}

// Walk up to the checkout this file lives in. `.git` is a directory in a normal
// clone and a file in a worktree, so `existsSync` covers both. Bounded so a
// detached path cannot spin.
function findCheckoutRoot(startDir) {
  let dir = startDir;
  for (let depth = 0; depth < 24; depth += 1) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function loadEnvFile(metaUrl, { only } = {}) {
  // Loading credentials is part of *running* a seeder, never part of importing
  // one. CI already runs the whole suite with no .env.local present, so staying
  // inert here just makes local runs match CI instead of hitting production.
  if (isTestRuntime() && process.env.WM_ALLOW_ENV_LOAD_IN_TESTS !== '1') {
    // Under a real test runner this is the expected path and would be pure
    // noise across 150+ seeder imports. NODE_ENV=test with no runner marker is
    // a person running a seeder in a shell that exports it, where silently
    // ignoring a .env.local that IS present reads as "my credentials vanished".
    if (process.env.NODE_ENV === 'test' && !TEST_RUNTIME_MARKERS.some((k) => process.env[k])) {
      console.error(
        '[seed] loadEnvFile skipped: NODE_ENV=test looks like a test runtime. ' +
          'Set WM_ALLOW_ENV_LOAD_IN_TESTS=1 to load credentials anyway.',
      );
    }
    return;
  }

  const __dirname = metaUrl ? dirname(fileURLToPath(metaUrl)) : process.cwd();
  const candidates = [];
  // Explicit opt-in for checkouts that deliberately borrow another env file.
  // Replaces the old hardcoded $HOME/Documents/GitHub/worldmonitor candidate,
  // which reached out of whichever worktree the seeder lived in and so made
  // worktree isolation ineffective by design.
  if (process.env.WM_SEED_ENV_FILE) {
    // Falling through to the checkout file on a typo would silently seed with
    // the wrong credentials — the failure mode this whole change is about.
    if (!existsSync(process.env.WM_SEED_ENV_FILE)) {
      console.error(
        `[seed] WM_SEED_ENV_FILE does not exist: ${process.env.WM_SEED_ENV_FILE} — ` +
          'falling back to the checkout .env.local.',
      );
    }
    candidates.push(process.env.WM_SEED_ENV_FILE);
  }
  // Anchored to the checkout root rather than guessed with `..` and `../..`.
  // The old pair had to guess because a nested `scripts/<dir>/x.mjs` needs two
  // levels while a top-level seeder needs one — but `../..` from a top-level
  // seeder lands OUTSIDE the checkout, and it really did load a `.env.local`
  // sitting next to the repo. Resolving the root makes both depths correct and
  // neither of them able to escape.
  const checkoutRoot = findCheckoutRoot(__dirname);
  // No VCS metadata means a container image, where env comes from the platform
  // and the only sane guess is the directory above the script.
  candidates.push(join(checkoutRoot ?? join(__dirname, '..'), '.env.local'));
  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    const lines = readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      if (only && !only.includes(key)) continue;
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
    return;
  }
}
