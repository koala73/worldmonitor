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

