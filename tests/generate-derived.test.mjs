import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { STEPS } from '../scripts/generate-derived.mjs';

const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;

// Scripts behind a *:check npm script that `npm run generate` deliberately
// leaves out. Anything else with a freshness check belongs in STEPS.
const NOT_DERIVED = new Map([
  ['scripts/generate-derived.mjs', 'the runner itself'],
  ['scripts/check-build-prereqs.mjs', 'validator'],
  ['scripts/bundle-budgets.mjs', 'validator over build output'],
  ['scripts/check-no-public-source-maps.mjs', 'deploy gate over build output'],
  ['scripts/docs-stats.mjs', 'validator'],
  ['scripts/generate-inventory-facts.mjs', 'gitignored build input; the runner refreshes it before the checks'],
  ['scripts/generate-third-party-notices.mjs', 'gitignored desktop build output'],
  ['scripts/check-live-video-sources.mjs', 'network probe'],
  ['scripts/build-sitemap.mjs', "follows main's commit dates; refreshed on schedule"],
  ['scripts/generate-docs-page-dates.mjs', "follows main's commit dates; regenerated before tests and builds"],
]);

test('every generator with a freshness check runs in npm run generate', () => {
  const covered = new Set(STEPS.map(([, command]) => command.find(arg => arg.startsWith('scripts/'))));
  const checked = Object.entries(scripts)
    .filter(([name]) => /(^|:)check(:|$)/.test(name))
    .flatMap(([, command]) => command.match(/scripts\/[\w./-]+\.(?:mjs|mts|cjs|js|py)/g) ?? []);
  const missing = [...new Set(checked)].filter(path => !covered.has(path) && !NOT_DERIVED.has(path));
  assert.deepEqual(missing, [], 'add these to STEPS in scripts/generate-derived.mjs or to NOT_DERIVED here');
});


test('checkSteps runs checks concurrently up to the bound and reports stale steps in declared order', async () => {
  const { checkSteps } = await import('../scripts/generate-derived.mjs');
  const delays = { a: 30, b: 5, c: 20, d: 1, e: 10 };
  const stale = new Set(['c', 'a']);
  let running = 0;
  let peak = 0;
  const runner = async ([name]) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise(resolve => setTimeout(resolve, delays[name]));
    running--;
    return { ok: !stale.has(name), output: `${name} output` };
  };
  const steps = Object.keys(delays).map(name => [name, [name]]);
  const result = await checkSteps(steps, { concurrency: 2, runner });
  assert.equal(peak, 2);
  assert.deepEqual(result.map(([name, , , output]) => [name, output]), [['a', 'a output'], ['c', 'c output']]);
});

test('checkSteps with concurrency 1 runs one check at a time', async () => {
  const { checkSteps } = await import('../scripts/generate-derived.mjs');
  let running = 0;
  let peak = 0;
  const runner = async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise(resolve => setTimeout(resolve, 2));
    running--;
    return { ok: true, output: '' };
  };
  const result = await checkSteps([['x', ['x']], ['y', ['y']], ['z', ['z']]], { concurrency: 1, runner });
  assert.equal(peak, 1);
  assert.deepEqual(result, []);
});

test('checkSteps reports a step whose command cannot start as stale instead of hanging', async () => {
  const { checkSteps } = await import('../scripts/generate-derived.mjs');
  const result = await checkSteps([['missing binary', ['/nonexistent/wm-generate-derived-probe']]]);
  assert.equal(result.length, 1);
  assert.equal(result[0][0], 'missing binary');
  assert.match(result[0][3], /ENOENT/);
});
