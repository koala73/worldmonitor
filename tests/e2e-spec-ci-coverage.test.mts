// Every Playwright spec in e2e/ must be run by a CI workflow, or be listed
// below with the reason it is not. Seventy specs once sat in e2e/ with no job
// running them; twenty of those had broken without anyone seeing it.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

type Job = { steps?: { run?: string }[]; strategy?: { matrix?: Record<string, unknown> } };
type Workflow = { jobs?: Record<string, Job> };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scripts: Record<string, string> = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts ?? {};
const workflowsDir = resolve(root, '.github/workflows');
const workflows = readdirSync(workflowsDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => YAML.parse(readFileSync(resolve(workflowsDir, name), 'utf8')) as Workflow);

// Specs no workflow runs, each with the reason. Shrink this list; do not grow
// it without a reason a reviewer can check.
const NOT_RUN_IN_CI: Record<string, string> = {
  'e2e/china-corridor-panel.spec.ts': 'broken: 2 of 5 tests fail on main',
  'e2e/food-prices.spec.ts':
    'broken on Linux: at 1440px the panel scrollWidth exceeds clientWidth by 5px with no element or text past its edge (passes on macOS; CI run 44274809907)',
  'e2e/forecast-row-layout.spec.ts':
    'flaky: at 390px the VOID summary click is intercepted by .fc-sim-label, then #mobileTabBar, until the 300s test timeout (both attempts, CI run 43796987099)',
  'e2e/live-media-intent.spec.ts': 'broken: 5 of 14 tests fail on main',
  'e2e/mission-presets.spec.ts': 'broken: 2 of 5 tests fail on main',
  'e2e/mobile-bottom-navigation.spec.ts': 'broken: 2 of 16 tests fail on main',
  'e2e/mobile-map-native.spec.ts': 'broken: 4 of 9 tests fail on main',
  'e2e/mobile-map-popup.spec.ts': 'broken: 2 of 22 tests fail on main',
  'e2e/nq-day-trader-mission.spec.ts': 'every test skips unless VITE_VARIANT=finance, and no job runs the finance variant',
  'e2e/oref-subscription-lifecycle.spec.ts': 'broken: 1 of 2 tests fails on main',
  'e2e/panel-drag-reorder.spec.ts': 'broken: 2 of 9 tests fail on main',
  'e2e/panel-vertical-scroll.spec.ts':
    'flaky: each test runs 1.9-2.5 min against its own 180s timeout and timed out at 1440px (CI run 43799166185)',
  'e2e/rag-vector-store.spec.ts': 'broken: 1 of 7 tests fails on main',
  'e2e/reservoir-levels.spec.ts': 'broken: 2 of 5 tests fail on main',
  'e2e/settings-diagnostics-layout.spec.ts':
    'broken on Linux: at 1.5x text the traffic log overflows its card by 27px (passes on macOS; CI run 43792167531)',
  'e2e/widget-builder.spec.ts': 'broken: 4 of 7 tests fail on main',
};

// Specs a CI script reaches by test title (-g) instead of by file path. The
// guard checks that a workflow runs the script and that the spec holds the title.
const RUN_BY_TITLE: Record<string, string> = {
  'e2e/map-harness.spec.ts': 'test:e2e:visual:full',
};

const SPEC = /e2e\/[\w./-]+\.spec\.[cm]?[jt]s/g;
const NPM_RUN = /npm run ([\w:.-]+)/g;

function listSpecs(dir = resolve(root, 'e2e')): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return listSpecs(path);
    return /\.spec\.[cm]?[jt]s$/.test(entry.name) ? [relative(root, path)] : [];
  });
}

type Row = Record<string, unknown>;
const matches = (row: Row, entry: Row) => Object.entries(entry).every(([key, value]) => row[key] === value);

// The job rows GitHub runs: the product of the matrix arrays, minus `exclude`
// matches, then each `include` entry merged into the rows it does not
// contradict on the original keys, or added as its own row.
function matrixRows(matrix: Record<string, unknown> = {}): Row[] {
  const keys = Object.keys(matrix).filter((key) => key !== 'include' && key !== 'exclude' && Array.isArray(matrix[key]));
  let rows: Row[] = [{}];
  for (const key of keys) rows = rows.flatMap((row) => (matrix[key] as unknown[]).map((value) => ({ ...row, [key]: value })));
  const excludes = (Array.isArray(matrix.exclude) ? matrix.exclude : []) as Row[];
  rows = rows.filter((row) => !excludes.some((entry) => matches(row, entry)));
  if (keys.length === 0) rows = [];
  for (const entry of (Array.isArray(matrix.include) ? matrix.include : []) as Row[]) {
    const original = Object.fromEntries(Object.entries(entry).filter(([key]) => keys.includes(key)));
    const targets = rows.filter((row) => matches(row, original));
    if (targets.length && Object.keys(original).length) targets.forEach((row) => Object.assign(row, entry));
    else rows.push({ ...entry });
  }
  return rows.length ? rows : [{}];
}

// Each row substitutes its own values into every `${{ matrix.<key> }}`, so
// fields from one include entry stay together.
function expandMatrix(command: string, matrix?: Record<string, unknown>): string[] {
  if (!/\$\{\{\s*matrix\./.test(command)) return [command];
  return matrixRows(matrix).flatMap((row) => {
    let missing = false;
    const text = command.replace(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g, (_, key: string) => {
      if (!(key in row)) missing = true;
      return String(row[key]);
    });
    return missing ? [] : [text];
  });
}

// Only `run:` steps count, with shell comments removed: a spec named in a
// paths filter, an artifact path or a comment is not run.
function scriptsAndSpecsRunByCi(workflowList: Workflow[], scriptMap: Record<string, string>) {
  const specs = new Set<string>();
  const reached = new Set<string>();
  const visit = (name: string) => {
    if (reached.has(name) || !(name in scriptMap)) return;
    reached.add(name);
    for (const match of scriptMap[name].matchAll(SPEC)) specs.add(match[0]);
    for (const match of scriptMap[name].matchAll(NPM_RUN)) visit(match[1]);
  };
  for (const workflow of workflowList) {
    for (const job of Object.values(workflow?.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (typeof step.run !== 'string') continue;
        for (const command of expandMatrix(step.run, job.strategy?.matrix)) {
          const live = command
            .split('\n')
            .map((line) => line.replace(/(^|\s)#.*$/, ''))
            .join('\n');
          for (const match of live.matchAll(SPEC)) specs.add(match[0]);
          for (const match of live.matchAll(NPM_RUN)) visit(match[1]);
        }
      }
    }
  }
  return { specs, scripts: reached };
}

describe('e2e spec CI coverage', () => {
  const specs = listSpecs();
  const run = scriptsAndSpecsRunByCi(workflows, scripts);

  it('runs every e2e spec in a CI workflow or names why it does not', () => {
    const orphans = specs.filter((spec) => !run.specs.has(spec) && !(spec in NOT_RUN_IN_CI) && !(spec in RUN_BY_TITLE));
    assert.deepEqual(
      orphans,
      [],
      'add each spec to a CI smoke shard (package.json test:e2e:ci-smoke:<n>), or list it in NOT_RUN_IN_CI with the reason',
    );
  });

  it('keeps NOT_RUN_IN_CI to specs that exist and are not run', () => {
    const stale = Object.keys(NOT_RUN_IN_CI).filter((spec) => !specs.includes(spec) || run.specs.has(spec));
    assert.deepEqual(stale, [], 'remove these from NOT_RUN_IN_CI: they were deleted or CI runs them now');
    const unexplained = Object.entries(NOT_RUN_IN_CI).filter(([, reason]) => !reason.trim()).map(([spec]) => spec);
    assert.deepEqual(unexplained, [], 'give each NOT_RUN_IN_CI entry a reason');
  });

  it('runs each title-selected spec through a script a workflow reaches, and the spec holds that title', () => {
    for (const [spec, script] of Object.entries(RUN_BY_TITLE)) {
      assert.ok(run.scripts.has(script), `${script} must be run by a workflow`);
      const title = /-g\s+"([^"]+)"/.exec(scripts[script] ?? '')?.[1];
      assert.ok(title, `${script} must select tests with -g "<title>"`);
      assert.ok(readFileSync(resolve(root, spec), 'utf8').includes(title), `${spec} must contain the title "${title}"`);
    }
  });

  it('counts only scripts a run step reaches, through the matrix values the job names', () => {
    const workflow: Workflow = {
      jobs: {
        e2e: {
          strategy: { matrix: { part: ['a', 'excluded'], exclude: [{ part: 'excluded' }], include: [{ part: 'b' }] } },
          steps: [{ run: 'npm run test:e2e:${{ matrix.part }}' }, { run: '# npm run test:e2e:commented' }],
        },
      },
    };
    const probe = {
      'test:e2e:a': 'playwright test e2e/a.spec.ts',
      'test:e2e:b': 'npm run test:e2e:nested',
      'test:e2e:nested': 'playwright test e2e/sub/nested.spec.ts',
      'test:e2e:uncalled': 'playwright test e2e/uncalled.spec.ts',
      'test:e2e:excluded': 'playwright test e2e/excluded.spec.ts',
      'test:e2e:commented': 'playwright test e2e/commented.spec.ts',
    };
    const result = scriptsAndSpecsRunByCi([workflow], probe);
    assert.deepEqual([...result.specs].sort(), ['e2e/a.spec.ts', 'e2e/sub/nested.spec.ts']);
  });
});
