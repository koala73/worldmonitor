import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '..');
const workflow = parse(readFileSync(join(root, '.github/workflows/test.yml'), 'utf8'));

function classify(files, { event = 'pull_request', count = files.length, fail = false, moved = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wm-test-selection-'));
  try {
    const entries = files.map((file) => typeof file === 'string' ? { filename: file } : file);
    writeFileSync(join(dir, 'pr.json'), JSON.stringify({ head: { sha: moved ? 'changed' : 'head' }, base: { sha: 'base' }, changed_files: count }));
    writeFileSync(join(dir, 'files.json'), JSON.stringify([entries]));
    writeFileSync(join(dir, 'compare.json'), JSON.stringify({ files: entries }));
    writeFileSync(join(dir, 'output'), '');
    writeFileSync(join(dir, 'gh'), fail ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh
case "$2" in
  */compare/*) cat "$FIXTURE/compare.json" ;;
  */files) cat "$FIXTURE/files.json" ;;
  *) cat "$FIXTURE/pr.json" ;;
esac
`, { mode: 0o755 });
    const values = {
      'github.event_name': event, 'github.event.before': 'before', 'github.repository': 'owner/repo',
      'github.sha': 'sha', 'github.event.number': '1',
      'github.event.pull_request.head.sha': 'head', 'github.event.pull_request.base.sha': 'base',
    };
    const script = workflow.jobs.changes.steps.find((step) => step.id === 'diff').run.replace(/\$\{\{ ([^}]+) \}\}/g, (_, name) => {
      assert.ok(Object.hasOwn(values, name), `unknown workflow expression ${name}`);
      return values[name];
    });
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, FIXTURE: dir, PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: join(dir, 'output') },
    });
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(readFileSync(join(dir, 'output'), 'utf8').trim().split('\n').map((line) => line.split('=')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('Railway-only changes retain unit proof and intentionally skip the browser', () => {
  const files = [
    '.github/workflows/railway-registry-sync.yml', 'scripts/audit-railway-watch-paths.mjs',
    'scripts/run-railway-registry-sync.mjs', 'scripts/railway-services.json',
    'tests/railway-registry-sync-cli.test.mjs', 'tests/railway-registry-sync-runner.test.mjs',
    'tests/railway-registry-sync-workflow.test.mjs', 'docs/solutions/example.md',
  ];
  for (const event of ['pull_request', 'push']) {
    const result = classify(files, { event });
    assert.equal(result.code, 'true');
    assert.equal(result.browser, 'false');
  }
  assert.equal(workflow.jobs['variant-smoke-full'].if, "needs.changes.outputs.browser == 'true'");
});

test('runtime, browser harness, assets, build inputs and unknown paths run the browser', () => {
  for (const file of [
    'src/app/App.ts', 'api/bootstrap.js', 'server/gateway.ts', 'shared/runtime.ts',
    'public/ai-search.md', 'pro-test/src/App.tsx', 'e2e/bootstrap-request-budget.spec.ts',
    'tests/map-harness.html', 'tests/fixtures/example.json', 'scripts/generate-product-config.mjs',
    'scripts/new-helper.mjs', 'package.json', 'package-lock.json', 'playwright.config.ts',
    '.github/workflows/test.yml', 'unknown/new-runtime.ts', '-n',
  ]) assert.equal(classify([file]).browser, 'true', file);
});

test('renames use both names and deletions still select their gates', () => {
  for (const event of ['pull_request', 'push']) {
    for (const file of [
      { filename: 'docs/archived.md', previous_filename: 'src/app/App.ts', status: 'renamed' },
      { filename: 'api/bootstrap.js', status: 'removed' },
    ]) {
      const result = classify([file], { event });
      assert.equal(result.code, 'true');
      assert.equal(result.browser, 'true');
    }
  }
});

test('unusable, incomplete and moved diff metadata runs every Test job', () => {
  for (const [files, options] of [
    [[], {}], [['docs/readme.md'], { fail: true }], [['docs/readme.md'], { moved: true }],
    [['docs/readme.md'], { count: 2 }], [['docs/readme.md'], { count: 3001 }],
    [['docs/line\nbreak.md'], {}], [[{}], {}],
    [Array.from({ length: 300 }, (_, i) => `docs/${i}.md`), { event: 'push' }],
  ]) {
    const result = classify(files, options);
    assert.ok(Object.values(result).every((value) => value === 'true'), JSON.stringify({ files: files.slice(0, 2), options, result }));
    assert.equal(Object.keys(result).length, Object.keys(workflow.jobs.changes.outputs).length);
  }
});

test('required unit aggregate rejects failed, cancelled and unexpected skips', () => {
  const aggregate = workflow.jobs.unit;
  assert.deepEqual(aggregate.needs, ['changes', 'unit-shards']);
  assert.equal(aggregate.if, 'always()');
  const shards = workflow.jobs['unit-shards'];
  assert.deepEqual(shards.strategy.matrix.shard, [1, 2]);
  assert.equal(shards.strategy['fail-fast'], false);
  assert.match(shards.steps.find((step) => step.run?.includes('WM_EXPECT_BUILT_OUTPUT=1 npm run test:data')).run, /--shard=\$\{\{ matrix.shard \}\}\/2 --concurrency=4/);
  for (const changes of ['success', 'failure', 'cancelled', 'skipped']) {
    for (const code of ['true', 'false', '']) {
      for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
        const expected = changes === 'success' && ((code === 'true' && result === 'success') || (code === 'false' && result === 'skipped'));
        const run = spawnSync('bash', ['-euo', 'pipefail', '-c', aggregate.steps[0].run], {
          encoding: 'utf8', env: { ...process.env, CHANGES_RESULT: changes, CODE_CHANGED: code, SHARDS_RESULT: result },
        });
        assert.equal(run.status === 0, expected, `${changes}/${code}/${result}`);
      }
    }
  }
});
