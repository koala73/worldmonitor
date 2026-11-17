import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { decideReuse, outputsFor, REUSE_BLOCKER } from '../.github/scripts/reuse-pr-test-verdict.mjs';

const root = resolve(import.meta.dirname, '..');
const workflow = parse(readFileSync(join(root, '.github/workflows/test.yml'), 'utf8'));
const NOW = Date.parse('2026-11-17T12:00:00Z');

const CODE_JOBS = ['unit-shard (1)', 'unit-shard (2)', 'unit-built-output', 'unit', 'sidecar', 'convex-tests', 'dom-tests'];
const BROWSER_JOBS = ['variant-smoke (1)', 'variant-smoke (2)', 'variant-smoke-pro-webmcp (webmcp)', 'variant-smoke-full'];

function fixture(overrides = {}) {
  const state = {
    pulls: [{ number: 7, merge_commit_sha: 'S', merged_at: '2026-11-17T11:00:00Z', base: { ref: 'main' }, head: { sha: 'H' } }],
    compare: { status: 'ahead' },
    trees: { S: 'T1', H: 'T1' },
    runs: [{ id: 99, status: 'completed', conclusion: 'success', created_at: '2026-11-17T10:00:00Z', updated_at: '2026-11-17T10:07:00Z' }],
    jobs: [...CODE_JOBS, ...BROWSER_JOBS, 'changes', 'docs-stats'].map((name) => ({ name, conclusion: 'success' })),
    ...overrides,
  };
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (state.fail && path.includes(state.fail)) throw new Error('HTTP 502');
    if (path === 'repos/o/r/commits/S/pulls') return state.pulls;
    if (path === 'repos/o/r/compare/P...H') return state.compare;
    const tree = path.match(/^repos\/o\/r\/git\/commits\/(\w+)$/);
    if (tree) return { tree: { sha: state.trees[tree[1]] } };
    if (path.startsWith('repos/o/r/actions/workflows/test.yml/runs?head_sha=H&event=pull_request')) return { workflow_runs: state.runs };
    if (path === 'repos/o/r/actions/runs/99/jobs?filter=latest&per_page=100') return { jobs: state.jobs, total_count: state.jobsTotal ?? state.jobs.length };
    throw new Error(`unexpected ${path}`);
  };
  return { api, calls };
}

const decide = (overrides, args = {}) => {
  const { api, calls } = fixture(overrides);
  return decideReuse({ api, repo: 'o/r', sha: 'S', before: 'P', files: ['src/app/App.ts'], now: NOW, ...args }).then((d) => ({ ...d, calls }));
};

describe('reuse of a green pull request Test verdict on a main push', () => {
  it('reuses both groups when the merged tree is the tested head tree', async () => {
    const d = await decide();
    assert.deepEqual(d.reuse, { code: true, browser: true });
    assert.deepEqual(outputsFor(d.reuse), { code: 'false', validation: 'false', browser: 'false' });
  });

  it('reuses only the groups the PR run actually ran and passed', async () => {
    const skipped = (names) => [...CODE_JOBS, ...BROWSER_JOBS].map((name) => ({ name, conclusion: names.includes(name) ? 'skipped' : 'success' }));
    assert.deepEqual((await decide({ jobs: skipped(BROWSER_JOBS) })).reuse, { code: true });
    assert.deepEqual((await decide({ jobs: skipped(['sidecar']) })).reuse, { browser: true });
    // A matrix leg missing from the listing must not read as "all present passed".
    const noShards = [...CODE_JOBS, ...BROWSER_JOBS].filter((n) => !n.startsWith('unit-shard')).map((name) => ({ name, conclusion: 'success' }));
    assert.deepEqual((await decide({ jobs: noShards })).reuse, { browser: true });
    assert.deepEqual(outputsFor({ browser: true }), { browser: 'false' });
  });

  it('never reuses when main moved under the head or the trees differ', async () => {
    for (const status of ['diverged', 'behind']) assert.deepEqual((await decide({ compare: { status } })).reuse, {});
    assert.deepEqual((await decide({ compare: { status: 'identical' } })).reuse, { code: true, browser: true });
    assert.deepEqual((await decide({ trees: { S: 'T1', H: 'T2' } })).reuse, {});
    assert.deepEqual((await decide({ trees: { S: undefined, H: undefined } })).reuse, {});
  });

  it('needs a merged pull request into main whose merge commit is this push', async () => {
    for (const pulls of [[], [{ number: 7, merge_commit_sha: 'X', merged_at: 'x', base: { ref: 'main' }, head: { sha: 'H' } }],
      [{ number: 7, merge_commit_sha: 'S', merged_at: null, base: { ref: 'main' }, head: { sha: 'H' } }],
      [{ number: 7, merge_commit_sha: 'S', merged_at: 'x', base: { ref: 'release' }, head: { sha: 'H' } }]]) {
      assert.deepEqual((await decide({ pulls })).reuse, {});
    }
  });

  it('trusts only the newest completed run, and only when it is green and under 24 hours old', async () => {
    const green = { id: 99, status: 'completed', conclusion: 'success', created_at: '2026-11-17T10:00:00Z', updated_at: '2026-11-17T10:07:00Z' };
    const red = { id: 100, status: 'completed', conclusion: 'failure', created_at: '2026-11-17T10:30:00Z', updated_at: '2026-11-17T10:37:00Z' };
    assert.deepEqual((await decide({ runs: [green, red] })).reuse, {});
    assert.deepEqual((await decide({ runs: [{ ...green, conclusion: 'cancelled' }] })).reuse, {});
    assert.deepEqual((await decide({ runs: [] })).reuse, {});
    assert.deepEqual((await decide({ runs: [{ ...green, updated_at: '2026-11-16T11:59:00Z' }] })).reuse, {});
    // An in-progress rerun is ignored; the newest completed one decides.
    assert.deepEqual((await decide({ runs: [green, { ...red, status: 'in_progress', conclusion: null }] })).reuse, { code: true, browser: true });
  });

  it('refuses an incomplete job listing', async () => {
    assert.deepEqual((await decide({ jobsTotal: 200 })).reuse, {});
  });

  it('never reuses a push that changes a cache key input or a workflow, and asks GitHub nothing', async () => {
    for (const file of ['package.json', 'package-lock.json', 'scripts/package-lock.json', 'blog-site/package.json', '.npmrc',
      'scripts/.npmrc', 'vendor/http-cache-semantics/index.js', '.github/workflows/test.yml', '.github/actions/install-root-deps/action.yml']) {
      assert.match(file, REUSE_BLOCKER, file);
      const d = await decide({}, { files: ['src/app/App.ts', file] });
      assert.deepEqual(d.reuse, {}, file);
      assert.deepEqual(d.calls, [], file);
    }
    for (const file of ['src/package-json.ts', 'docs/package.json.md', 'tests/fixtures/package.json.gz']) assert.doesNotMatch(file, REUSE_BLOCKER, file);
  });

  it('runs everything without a parent SHA or a file list', async () => {
    for (const args of [{ before: '' }, { before: '0000000000000000000000000000000000000000' }, { files: [] }, { files: undefined }]) {
      assert.deepEqual((await decide({}, args)).reuse, {}, JSON.stringify(args));
    }
  });

  it('propagates API failures so the caller runs every job', async () => {
    await assert.rejects(decide({ fail: '/jobs' }));
    await assert.rejects(decide({ fail: '/compare/' }));
  });
});

describe('test.yml wiring', () => {
  const changes = workflow.jobs.changes;
  const reuse = changes.steps.find((step) => step.id === 'reuse');

  it('runs the reuse step on push only, after the diff, and cannot fail the job', () => {
    const ids = changes.steps.map((step) => step.id);
    assert.ok(ids.indexOf('reuse') > ids.indexOf('diff'), 'reuse must read the diff step outputs');
    assert.equal(reuse.if, "github.event_name == 'push'");
    assert.equal(reuse['continue-on-error'], true);
    assert.match(reuse.run, /node \.github\/scripts\/reuse-pr-test-verdict\.mjs/);
    assert.equal(reuse.env.FILES_JSON, '${{ steps.diff.outputs.files_json }}');
    assert.equal(reuse.env.BEFORE, '${{ github.event.before }}');
    const checkout = changes.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.if, "github.event_name == 'push'");
    assert.ok(changes.steps.indexOf(checkout) < changes.steps.indexOf(reuse), 'the script must be checked out before it runs');
    assert.deepEqual(checkout.with['sparse-checkout'].trim().split('\n'), ['.github/scripts/reuse-pr-test-verdict.mjs', 'scripts/lib/main-module.mjs']);
  });

  it('lets reuse only switch code, validation and browser off, never on', () => {
    for (const key of ['code', 'validation', 'browser']) {
      assert.equal(changes.outputs[key], `\${{ steps.reuse.outputs.${key} || steps.diff.outputs.${key} }}`, key);
    }
    for (const key of Object.keys(changes.outputs).filter((k) => !['code', 'validation', 'browser'].includes(k))) {
      assert.doesNotMatch(changes.outputs[key], /steps\.reuse/, key);
    }
    assert.deepEqual(Object.values(outputsFor({ code: true, browser: true })), ['false', 'false', 'false']);
  });

  it('grants the read scopes the lookups need', () => {
    assert.equal(changes.permissions.actions, 'read');
    assert.equal(changes.permissions.contents, 'read');
  });
});
