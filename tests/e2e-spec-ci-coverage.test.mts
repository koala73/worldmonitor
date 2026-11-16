// Every Playwright spec in e2e/ must be run by a CI workflow, or be listed
// below with the reason it is not. Seventy specs once sat in e2e/ with no job
// running them; twenty of those had broken without anyone seeing it.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scripts: Record<string, string> = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts ?? {};
const workflowsDir = resolve(root, '.github/workflows');
const workflows = readdirSync(workflowsDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => readFileSync(resolve(workflowsDir, name), 'utf8'));

// Specs no workflow runs, each with the reason. Shrink this list; do not grow
// it without a reason a reviewer can check.
const NOT_RUN_IN_CI: Record<string, string> = {
  'e2e/auth-ui.spec.ts': 'broken: no test passes on main',
  'e2e/channel-oauth-binding.spec.mjs': 'broken: no test passes on main',
  'e2e/china-corridor-panel.spec.ts': 'broken: 2 of 5 tests fail on main',
  'e2e/deduct-situation.spec.ts': 'broken: no test passes on main',
  'e2e/food-prices.spec.ts': 'broken: no test passes on main',
  'e2e/header-signed-out-auth.spec.ts': 'broken: no test passes on main',
  'e2e/live-media-intent.spec.ts': 'broken: 5 of 14 tests fail on main',
  'e2e/mission-presets.spec.ts': 'broken: 2 of 5 tests fail on main',
  'e2e/mobile-bottom-navigation.spec.ts': 'broken: 2 of 16 tests fail on main',
  'e2e/mobile-map-native.spec.ts': 'broken: 4 of 9 tests fail on main',
  'e2e/mobile-map-popup.spec.ts': 'broken: 2 of 22 tests fail on main',
  'e2e/naval-group-navigation.spec.ts': 'broken: 1 of 4 tests times out on main',
  'e2e/nq-day-trader-mission.spec.ts': 'every test skips unless VITE_VARIANT=finance, and no job runs the finance variant',
  'e2e/oref-subscription-lifecycle.spec.ts': 'broken: 1 of 2 tests fails on main',
  'e2e/panel-drag-reorder.spec.ts': 'broken: 2 of 9 tests fail on main',
  'e2e/rag-vector-store.spec.ts': 'broken: 1 of 7 tests fails on main',
  'e2e/reservoir-levels.spec.ts': 'broken: 2 of 5 tests fail on main',
  'e2e/settings-diagnostics-layout.spec.ts': 'broken on Linux: at 1.5x text the traffic log overflows its card by 27px (passes on macOS; CI run 43792167531)',
  'e2e/theme-toggle.spec.ts': 'broken: 7 of 8 tests fail on main',
  'e2e/ukmto-incidents.spec.ts': 'broken: 1 of 7 tests fails on main',
  'e2e/widget-builder.spec.ts': 'broken: 4 of 7 tests fail on main',
};

const SPEC = /e2e\/[\w.-]+\.spec\.[cm]?[jt]s/g;

function specsRunByCi(): Set<string> {
  const found = new Set<string>();
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name) || !(name in scripts)) return;
    seen.add(name);
    const command = scripts[name];
    for (const match of command.matchAll(SPEC)) found.add(match[0]);
    for (const match of command.matchAll(/npm run ([\w:.-]+)/g)) visit(match[1]);
  };
  for (const text of workflows) {
    for (const match of text.matchAll(SPEC)) found.add(match[0]);
    // `npm run test:e2e:ci-smoke:${{ matrix.shard }}` reaches every script the
    // matrix expression can name, so the expression matches any suffix.
    for (const match of text.matchAll(/npm run ([\w:.-]+(?:\$\{\{[^}]+\}\}[\w:.-]*)*)/g)) {
      const pattern = new RegExp(`^${match[1].split(/\$\{\{[^}]+\}\}/).map((part) => part.replace(/[.*+?^$()|[\]\\]/g, '\\$&')).join('[\\w.-]+')}$`);
      for (const script of Object.keys(scripts)) if (pattern.test(script)) visit(script);
    }
  }
  return found;
}

describe('e2e spec CI coverage', () => {
  const specs = readdirSync(resolve(root, 'e2e'))
    .filter((name) => /\.spec\.[cm]?[jt]s$/.test(name))
    .map((name) => `e2e/${name}`);
  const run = specsRunByCi();

  it('runs every e2e spec in a CI workflow or names why it does not', () => {
    const orphans = specs.filter((spec) => !run.has(spec) && !(spec in NOT_RUN_IN_CI));
    assert.deepEqual(orphans, [], 'add each spec to a CI smoke shard (package.json test:e2e:ci-smoke:<n>), or list it in NOT_RUN_IN_CI with the reason');
  });

  it('keeps NOT_RUN_IN_CI to specs that exist and are not run', () => {
    const stale = Object.keys(NOT_RUN_IN_CI).filter((spec) => !specs.includes(spec) || run.has(spec));
    assert.deepEqual(stale, [], 'remove these from NOT_RUN_IN_CI: they were deleted or CI runs them now');
  });
});
