import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import YAML from 'yaml';

const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/codeql.yml', import.meta.url), 'utf8'));
const selector = workflow.jobs.changes.steps.find(step => step.id === 'select').with.script;
const all = ['actions', 'go', 'javascript-typescript', 'python', 'ruby', 'rust'];

async function select(paths, options = {}) {
  const outputs = {};
  const calls = {};
  const files = paths.map(path => typeof path === 'string' ? { filename: path } : path);
  const github = {
    rest: {
      actions: { async listWorkflowRuns(params) {
        calls.runs = params;
        if (options.error === 'runs') throw new Error('API unavailable');
        return { data: { workflow_runs: options.noBaseline ? [] : [{ head_sha: 'last' }] } };
      } },
      repos: { async compareCommitsWithBasehead(params) {
        calls.compare = params;
        if (options.error === 'compare') throw new Error('API unavailable');
        return { data: { status: options.status ?? 'ahead', files } };
      } },
    },
  };
  const context = { eventName: options.event ?? 'push', sha: 'head', repo: { owner: 'test', repo: 'test' }, payload: {} };
  await runInNewContext(`(async () => { ${selector} })()`, {
    github, context, core: { setOutput: (key, value) => { outputs[key] = value; }, warning() {} },
  });
  // Objects built inside the vm realm have foreign prototypes; compare them as JSON.
  return options.calls ? JSON.parse(JSON.stringify(calls)) : JSON.parse(outputs.languages);
}

test('selects only affected languages, including source outside SDK directories', async () => {
  for (const [path, language] of [
    ['src/app.ts', 'javascript-typescript'], ['api/data.mjs', 'javascript-typescript'],
    ['widget.jsx', 'javascript-typescript'], ['module.cts', 'javascript-typescript'],
    ['scripts/convert.py', 'python'], ['sdk/go/worldmonitor.go', 'go'],
    ['lib/example.rb', 'ruby'], ['src-tauri/src/main.rs', 'rust'],
    ['.github/workflows/test.yml', 'actions'], ['action.yaml', 'actions'],
  ]) assert.deepEqual(await select([path]), [language], path);
  assert.deepEqual(await select(['docs/readme.md']), []);
  assert.deepEqual(await select(['sdk/go/go.mod', 'sdk/go/go.sum']), ['go']);
  assert.deepEqual(await select(['src-tauri/Cargo.lock']), ['rust']);
  assert.deepEqual(await select(['package-lock.json']), ['javascript-typescript']);
});

test('includes renamed-away and deleted source paths', async () => {
  assert.deepEqual(await select([{ filename: 'docs/old.txt', previous_filename: 'old.py' }]), ['python']);
  assert.deepEqual(await select([{ filename: 'old.rb', status: 'removed' }]), ['ruby']);
});

test('diffs from the last successful push scan on main, so coalesced pushes still count', async () => {
  const calls = await select(['src/app.ts'], { calls: true });
  assert.deepEqual(calls.runs, {
    owner: 'test', repo: 'test', workflow_id: 'codeql.yml', branch: 'main', event: 'push', status: 'success', per_page: 1,
  });
  assert.deepEqual(calls.compare, { owner: 'test', repo: 'test', basehead: 'last...head' });
});

test('scans all languages if the diff is unreliable or scan configuration changes', async () => {
  for (const options of [
    { error: 'runs' }, { error: 'compare' }, { noBaseline: true },
    { status: 'diverged' }, { status: 'behind' }, { status: 'identical' },
  ]) assert.deepEqual(await select(['docs/readme.md'], options), all, JSON.stringify(options));
  assert.deepEqual(await select([]), all);
  assert.deepEqual(await select([{ filename: null }]), all);
  assert.deepEqual(await select(['.github/workflows/codeql.yml']), all);
  assert.deepEqual(await select(['.github/codeql/config.yml']), all);
  assert.deepEqual(await select(Array.from({ length: 300 }, () => 'docs/readme.md')), all);
  assert.deepEqual(await select(Array.from({ length: 299 }, () => 'docs/readme.md')), []);
});

test('pushes to main and a weekly all-language scan, never PRs', async () => {
  assert.deepEqual(await select([], { event: 'schedule' }), all);
  assert.deepEqual(await select([], { event: 'workflow_dispatch' }), all);
  assert.equal('pull_request' in workflow.on, false);
  assert.equal('pull_request_target' in workflow.on, false);
  assert.deepEqual(workflow.on.push, { branches: ['main'] });
  assert.deepEqual(workflow.on.schedule.map(entry => entry.cron), ['23 3 * * 0']);
  assert.ok('workflow_dispatch' in workflow.on);
  // Pushes coalesce instead of cancelling; schedule and dispatch use their own groups.
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(workflow.concurrency.group, 'codeql-${{ github.event_name }}-${{ github.ref }}');
  assert.deepEqual(workflow.jobs.changes.permissions, { actions: 'read', contents: 'read' });
});

test('scan jobs use selected languages, least privilege, and stable categories', () => {
  const analyze = workflow.jobs.analyze;
  assert.match(analyze.if, /needs.changes.outputs.languages != '\[\]'/);
  assert.equal(analyze.strategy.matrix.language, '${{ fromJSON(needs.changes.outputs.languages) }}');
  assert.equal(analyze.permissions['security-events'], 'write');
  assert.equal(workflow.permissions.contents, 'read');
  const init = analyze.steps.find(step => step.uses?.startsWith('github/codeql-action/init@'));
  assert.equal(init.with['build-mode'], "${{ matrix.language == 'go' && 'autobuild' || 'none' }}");
  assert.equal(init.with.languages, '${{ matrix.language }}');
  const upload = analyze.steps.find(step => step.uses?.startsWith('github/codeql-action/analyze@'));
  assert.equal(upload.with.category, '/language:${{ matrix.language }}');
  assert.equal(init.uses.split('@')[1], upload.uses.split('@')[1], 'CodeQL init and analyze must use the same version');
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) {
    if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
  }
});

test('Dependabot updates all CodeQL actions together', () => {
  const dependabot = YAML.parse(readFileSync(new URL('../.github/dependabot.yml', import.meta.url), 'utf8'));
  const actions = dependabot.updates.find(update => update['package-ecosystem'] === 'github-actions');
  const group = actions.groups?.codeql;
  assert.ok(group, 'CodeQL actions need a shared update group');
  assert.deepEqual(group.patterns, ['github/codeql-action/*']);
  assert.equal(group['applies-to'] ?? 'version-updates', 'version-updates');
});

test('default-branch runs prune stale overlay-base caches with the only actions: write grant', () => {
  const prune = workflow.jobs['prune-overlay-bases'];
  assert.ok(prune, 'prune-overlay-bases job exists');
  assert.equal(prune.needs, 'analyze');
  assert.match(prune.if, /!cancelled\(\)/);
  assert.match(prune.if, /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  assert.deepEqual(prune.permissions, { contents: 'read', actions: 'write' });
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name !== 'prune-overlay-bases') assert.notEqual(job.permissions?.actions, 'write', name);
  }
  assert.equal(workflow.permissions.actions, undefined);
  const checkout = prune.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['persist-credentials'], false);
  const run = prune.steps.find(step => step.run);
  assert.match(run.run, /node \.github\/scripts\/prune-codeql-overlay-bases\.mjs --ref "\$GITHUB_REF"/);
  assert.doesNotMatch(run.run, /--dry-run/);
  assert.equal(run.env.GH_TOKEN, '${{ github.token }}');
  assert.equal(run.env.GH_REPO, '${{ github.repository }}');
  for (const step of prune.steps) if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
});
