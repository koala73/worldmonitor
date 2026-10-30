import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import YAML from 'yaml';

const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/codeql.yml', import.meta.url), 'utf8'));
const all = ['actions', 'go', 'javascript-typescript', 'python', 'ruby', 'rust'];

test('one daily all-language scan, never on PRs or pushes', () => {
  assert.equal('pull_request' in workflow.on, false);
  assert.equal('pull_request_target' in workflow.on, false);
  assert.equal('push' in workflow.on, false);
  assert.deepEqual(workflow.on.schedule.map(entry => entry.cron), ['23 3 * * *']);
  assert.ok('workflow_dispatch' in workflow.on);
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(workflow.concurrency.group, 'codeql-${{ github.event_name }}-${{ github.ref }}');
});

test('scan jobs cover every language with least privilege and stable categories', () => {
  const analyze = workflow.jobs.analyze;
  assert.deepEqual(analyze.strategy.matrix.language, all);
  assert.equal(analyze.needs, undefined);
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
