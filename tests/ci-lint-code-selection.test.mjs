// The Lint Code workflow owns an expensive rendered-doc anchor check. These
// tests execute its real path classifier so code-only changes can skip the
// export without losing docs changes, renames, deletions, or renderer canaries.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '..');
const workflow = parse(readFileSync(join(root, '.github/workflows/lint-code.yml'), 'utf8'));
const CLASSIFIER = join(root, '.github/scripts/lint-code-changes.sh');

function diffStep(job) {
  const step = workflow.jobs[job].steps.find((candidate) => candidate.id === 'diff');
  assert.ok(step, `${job} must classify the PR in a step with id diff`);
  return step;
}

function classify(files, {
  event = 'pull_request',
  pages,
  changedFiles,
  eventHead = 'event-head',
  eventBase = 'event-base',
  prHead = eventHead,
  prBase = eventBase,
  filePayload,
  ghMode = 'success',
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wm-lint-code-selection-'));
  try {
    const normalize = (file) => typeof file === 'string' ? { filename: file } : file;
    const filePages = (pages ?? [files]).map((page) => page.map(normalize));
    const listedCount = filePages.reduce((count, page) => count + page.length, 0);
    writeFileSync(join(dir, 'pr.json'), JSON.stringify({
      changed_files: changedFiles ?? listedCount,
      head: { sha: prHead },
      base: { sha: prBase },
    }));
    writeFileSync(join(dir, 'files.json'), filePayload ?? JSON.stringify(filePages));
    writeFileSync(join(dir, 'output'), '');
    writeFileSync(join(dir, 'gh'), `#!/bin/sh
if [ "$GH_MODE" = "fail" ]; then
  exit 1
fi
case "$2" in
  */files)
    cat "$FIXTURE/files.json"
    if [ "$GH_MODE" = "partial-files-failure" ]; then
      exit 1
    fi
    ;;
  *)
    cat "$FIXTURE/pr.json"
    ;;
esac
`, { mode: 0o755 });

    // The inputs each job's diff step passes, resolved as Actions would.
    const values = {
      'github.token': 'token',
      'github.event_name': event,
      'github.repository': 'owner/repo',
      'github.event.number': '1',
      'github.event.pull_request.head.sha': eventHead,
      'github.event.pull_request.base.sha': eventBase,
    };
    const stepEnv = Object.fromEntries(Object.entries(diffStep('biome').env).map(([key, value]) => [
      key,
      value.replace(/\$\{\{ ([^}]+) \}\}/g, (_, name) => {
        assert.ok(Object.hasOwn(values, name), `unknown workflow expression ${name}`);
        return values[name];
      }),
    ]));
    const result = spawnSync('bash', [CLASSIFIER], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        ...stepEnv,
        FIXTURE: dir,
        GH_MODE: ghMode,
        PATH: `${dir}:${process.env.PATH}`,
        GITHUB_OUTPUT: join(dir, 'output'),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(
      readFileSync(join(dir, 'output'), 'utf8').trim().split('\n').map((line) => line.split('=')),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertFailsOpen(result) {
  assert.deepEqual(result, { code: 'true', markdown: 'true', docs: 'true' });
}

test('doc-anchors runs for every repository input that can change rendered anchors', () => {
  const docsOnly = classify(['docs/about.mdx']);
  assert.equal(docsOnly.code, 'false');
  assert.equal(docsOnly.markdown, 'false');
  assert.equal(docsOnly.docs, 'true');
  for (const file of [
    'scripts/check-doc-anchors.mjs',
    'scripts/_html-entities.mjs',
    'scripts/mint-export-preload.mjs',
    '.github/workflows/lint-code.yml',
  ]) {
    assert.equal(classify([file]).docs, 'true', file);
  }
});

test('doc-anchors skips code-only changes and runs for mixed changes', () => {
  assert.equal(classify(['src/app/App.ts']).docs, 'false');
  const mixed = classify([], { pages: [['src/app/App.ts'], ['docs/about.mdx']] });
  assert.equal(mixed.code, 'true');
  assert.equal(mixed.docs, 'true');
});

test('doc-anchors counts both sides of renames and deleted docs', () => {
  assert.equal(classify([{
    filename: 'archive/about.mdx',
    previous_filename: 'docs/about.mdx',
    status: 'renamed',
  }]).docs, 'true');
  assert.equal(classify([{ filename: 'docs/deleted.mdx', status: 'removed' }]).docs, 'true');
});

test('an unreadable PR file list fails open', () => {
  assertFailsOpen(classify(['src/app/App.ts'], { ghMode: 'fail' }));
});

test('a partial pagination failure fails open even after valid page JSON', () => {
  assertFailsOpen(classify([], {
    pages: [['src/app/App.ts'], ['docs/about.mdx']],
    ghMode: 'partial-files-failure',
  }));
});

test('malformed or unusable successful file listings fail open', () => {
  assertFailsOpen(classify(['src/app/App.ts'], { filePayload: 'not json' }));
  assertFailsOpen(classify([{ filename: '' }]));
});

test('an incomplete file list fails open when changed_files is larger', () => {
  assertFailsOpen(classify(['src/app/App.ts'], { changedFiles: 2 }));
});

test('stale PR head or base metadata fails open', () => {
  assertFailsOpen(classify(['src/app/App.ts'], { prHead: 'stale-head' }));
  assertFailsOpen(classify(['src/app/App.ts'], { prBase: 'stale-base' }));
});

test('the GitHub 3000-file cap fails open', () => {
  const files = Array.from({ length: 3000 }, (_, index) => `src/file-${index}.ts`);
  assertFailsOpen(classify(files));
});

test('the weekly renderer canary keeps every required lint classifier enabled', () => {
  assert.deepEqual(workflow.on.schedule, [{ cron: '17 6 * * 1' }]);
  const result = classify([], { event: 'schedule' });
  assert.equal(result.code, 'true');
  assert.equal(result.markdown, 'true');
  assert.equal(result.docs, 'true');
});

test('pushes to main keep every gated lint classifier enabled', () => {
  const result = classify([], { event: 'push' });
  assert.equal(result.code, 'true');
  assert.equal(result.markdown, 'true');
  assert.equal(result.docs, 'true');
});

test('doc-anchors is gated by the docs classifier', () => {
  assert.match(readFileSync(CLASSIFIER, 'utf8'), /^set -euo pipefail$/m);
  const steps = workflow.jobs['docs-lint'].steps;
  const exportStep = steps.find((step) => step.name === 'Export rendered docs');
  assert.equal(exportStep.if, "${{ !cancelled() && steps.diff.outputs.docs == 'true' }}");
  for (const name of ['Unpack export', 'Every doc anchor resolves']) {
    assert.equal(steps.find((step) => step.name === name).if, "${{ !cancelled() && steps.export.outcome == 'success' }}");
  }
});

test('both Lint Code jobs run the same classifier before any check', () => {
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ['biome', 'docs-lint']);
  for (const job of ['biome', 'docs-lint']) {
    const steps = workflow.jobs[job].steps;
    const step = diffStep(job);
    assert.equal(step.run, 'bash .github/scripts/lint-code-changes.sh');
    assert.deepEqual(step.env, diffStep('biome').env, `${job} must classify with the same inputs`);
    assert.equal(workflow.jobs[job].permissions['pull-requests'], 'read');
    assert.ok(steps[0].uses.startsWith('actions/checkout@'), `${job} checks out the classifier first`);
    assert.equal(steps.indexOf(step), 1, `${job} classifies before any check`);
  }
  const biomeCheck = workflow.jobs.biome.steps.find((step) => step.name === 'Run lint and invariant checks');
  assert.equal(biomeCheck.if, "steps.diff.outputs.code == 'true'");
  const markdown = workflow.jobs['docs-lint'].steps.find((step) => step.name === 'Markdown lint');
  assert.equal(markdown.if, "${{ !cancelled() && steps.diff.outputs.markdown == 'true' }}");
});

test('a classifier change reruns the docs anchor export', () => {
  assert.equal(classify(['.github/scripts/lint-code-changes.sh']).docs, 'true');
});
