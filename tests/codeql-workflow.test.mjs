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
  const files = paths.map(path => typeof path === 'string' ? { filename: path } : path);
  const github = {
    rest: { pulls: {
      listFiles() {},
      async get() { return { data: { head: { sha: 'head' }, base: { sha: 'base' }, changed_files: files.length, ...options.metadata } }; },
    } },
    async paginate() { if (options.error) throw new Error('API unavailable'); return files; },
  };
  const context = {
    eventName: options.event ?? 'pull_request', repo: { owner: 'test', repo: 'test' },
    payload: { schedule: options.schedule, pull_request: { number: 1, head: { sha: 'head' }, base: { sha: 'base' } } },
  };
  await runInNewContext(`(async () => { ${selector} })()`, {
    github, context, core: { setOutput: (key, value) => { outputs[key] = value; }, warning() {} },
  });
  return JSON.parse(outputs.languages);
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

test('scans all languages if lookup is unreliable or scan configuration changes', async () => {
  for (const options of [
    { error: true }, { metadata: { changed_files: 3001 } },
    { metadata: { head: { sha: 'moved' } } }, { metadata: { base: { sha: 'moved' } } },
  ]) assert.deepEqual(await select(['docs/readme.md'], options), all);
  assert.deepEqual(await select([]), all);
  assert.deepEqual(await select([{ filename: null }]), all);
  assert.deepEqual(await select(['.github/workflows/codeql.yml']), all);
  assert.deepEqual(await select(['.github/codeql/config.yml']), all);
  assert.deepEqual(await select(Array.from({ length: 3000 }, () => 'docs/readme.md')), all);
});

test('daily JS/TS and weekly all-language scans, with full manual recovery', async () => {
  assert.deepEqual(await select([], { event: 'schedule', schedule: '23 3 * * 1-6' }), ['javascript-typescript']);
  assert.deepEqual(await select([], { event: 'schedule', schedule: '23 3 * * 0' }), all);
  assert.deepEqual(await select([], { event: 'workflow_dispatch' }), all);
  assert.deepEqual(await select([], { event: 'push' }), all);
  assert.deepEqual(workflow.on.schedule.map(entry => entry.cron), ['23 3 * * 1-6', '23 3 * * 0']);
  // CodeQL warns on every run without an on.push hook. Scoping it to this file
  // silences that and scans all languages on main when scan config lands.
  assert.deepEqual(workflow.on.push, { branches: ['main'], paths: ['.github/workflows/codeql.yml'] });
  assert.ok('pull_request' in workflow.on);
  assert.equal(workflow.on.pull_request?.paths, undefined);
});

test('scan jobs use selected languages, least privilege, and stable categories', () => {
  const analyze = workflow.jobs.analyze;
  assert.match(analyze.if, /needs.changes.outputs.languages != '\[\]'/);
  assert.equal(analyze.strategy.matrix.language, '${{ fromJSON(needs.changes.outputs.languages) }}');
  assert.equal(analyze.permissions['security-events'], 'write');
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}");
  assert.match(workflow.concurrency.group, /github.run_id/);
  const init = analyze.steps.find(step => step.uses?.startsWith('github/codeql-action/init@'));
  assert.equal(init.with['build-mode'], "${{ matrix.language == 'go' && 'autobuild' || 'none' }}");
  assert.equal(init.with.languages, '${{ matrix.language }}');
  const upload = analyze.steps.find(step => step.uses?.startsWith('github/codeql-action/analyze@'));
  assert.equal(upload.with.category, '/language:${{ matrix.language }}');
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) {
    if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
  }
});
