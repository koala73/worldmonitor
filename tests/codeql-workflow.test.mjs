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

test('only the generated @vercel/og bundle is excluded from scanning', () => {
  const init = workflow.jobs.analyze.steps.find(step => step.uses?.startsWith('github/codeql-action/init@'));
  const config = YAML.parse(init.with.config ?? '');
  // The bundle is upstream satori/opentype.js output from scripts/vendor-vercel-og.mjs; it
  // re-raised 22 alerts after #9782. Our patched vendor copies and the script stay scanned.
  assert.deepEqual(config?.['paths-ignore'], ['vendor/vercel-og/dist']);
  assert.equal(config.paths, undefined, 'a paths list would narrow every other scan');
});

test('Dependabot updates all CodeQL actions together', () => {
  const dependabot = YAML.parse(readFileSync(new URL('../.github/dependabot.yml', import.meta.url), 'utf8'));
  const actions = dependabot.updates.find(update => update['package-ecosystem'] === 'github-actions');
  const group = actions.groups?.codeql;
  assert.ok(group, 'CodeQL actions need a shared update group');
  assert.deepEqual(group.patterns, ['github/codeql-action/*']);
  assert.equal(group['applies-to'] ?? 'version-updates', 'version-updates');
});

test('scans never build overlay-base databases nobody restores', () => {
  // Only overlay scans of pull requests restore a base, and this workflow never runs
  // on them; each default-branch base was ~2 GB of Actions cache evicting what PRs read.
  assert.equal(workflow.jobs.analyze.env?.CODEQL_OVERLAY_DATABASE_MODE, 'none');
  // Overlay off turns TRAP caching on, and default-branch runs only ever upload it.
  const init = workflow.jobs.analyze.steps.find(step => step.uses?.startsWith('github/codeql-action/init@'));
  assert.equal(init.with['trap-caching'], false);
  assert.deepEqual(Object.keys(workflow.jobs), ['analyze'], 'no cache-pruning job is needed');
  for (const job of Object.values(workflow.jobs)) assert.notEqual(job.permissions?.actions, 'write');
  assert.equal(workflow.permissions.actions, undefined);
});
