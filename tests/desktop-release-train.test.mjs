import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

import {
  compareReleaseVersions,
  releaseVersionFromTag,
  resolveDesktopRelease,
} from '../scripts/resolve-desktop-release.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(root, '.github/workflows/desktop-release-train.yml');
const workflowSource = readFileSync(workflowPath, 'utf8');
const workflow = loadYaml(workflowSource);
// `on:` is parsed as boolean `true` by YAML 1.1, which js-yaml implements.
const triggers = workflow.on ?? workflow[true];
const steps = workflow.jobs.prepare.steps;
const stepNamed = (name) => {
  const matches = steps.filter((step) => step.name === name);
  assert.equal(matches.length, 1, `expected one "${name}" step`);
  return matches[0];
};

test('release version comparison is numeric and strict', () => {
  assert.equal(compareReleaseVersions('2.10.0', '2.5.23'), 1);
  assert.equal(compareReleaseVersions('2.5.23', '2.5.23'), 0);
  assert.equal(compareReleaseVersions('2.4.99', '2.5.0'), -1);
  assert.throws(() => compareReleaseVersions('2.10.0-beta.1', '2.5.23'), /strict MAJOR\.MINOR\.PATCH/);
  assert.throws(() => compareReleaseVersions(' 2.10.0', '2.5.23'), /strict MAJOR\.MINOR\.PATCH/);
  assert.throws(() => compareReleaseVersions('999999999999999999.0.0', '2.5.23'), /safe integer range/);
  assert.throws(() => releaseVersionFromTag('v2.10.0-tech'), /vMAJOR\.MINOR\.PATCH/);
});

test('release resolution only advances when package.json is newer', () => {
  assert.deepEqual(
    resolveDesktopRelease({ packageVersion: '2.10.0', latestReleaseTag: 'v2.5.23' }),
    {
      action: 'release',
      tag: 'v2.10.0',
      latestReleaseTag: 'v2.5.23',
      reason: 'v2.10.0 is newer than published v2.5.23',
    },
  );
  assert.equal(resolveDesktopRelease({ packageVersion: '2.5.23', latestReleaseTag: 'v2.5.23' }).action, 'noop');
  assert.equal(resolveDesktopRelease({ packageVersion: '2.5.22', latestReleaseTag: 'v2.5.23' }).action, 'noop');
  assert.equal(resolveDesktopRelease({ packageVersion: '2.5.23' }).action, 'release');
  assert.throws(
    () => resolveDesktopRelease({ packageVersion: '2.10.0', latestReleaseTag: 'release-2.5.23' }),
    /vMAJOR\.MINOR\.PATCH/,
  );
});

test('the CLI emits workflow outputs and fails closed on invalid versions', () => {
  const script = resolve(root, 'scripts/resolve-desktop-release.mjs');
  const resolved = spawnSync(process.execPath, [script, '2.10.0', 'v2.5.23'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.match(resolved.stdout, /^action=release$/m);
  assert.match(resolved.stdout, /^tag=v2\.10\.0$/m);

  const invalid = spawnSync(process.execPath, [script, '2.10.0-beta.1', 'v2.5.23'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /strict MAJOR\.MINOR\.PATCH/);
});

test('the workflow watches release inputs, runs serially, and has the required write permissions', () => {
  assert.deepEqual(triggers.push.branches, ['main']);
  assert.ok(triggers.push.paths.includes('package.json'));
  assert.ok(triggers.push.paths.includes('scripts/resolve-desktop-release.mjs'));
  assert.ok(triggers.push.paths.includes('src-tauri/tauri.conf.json'));
  assert.ok(triggers.push.paths.includes('.github/workflows/desktop-release-train.yml'));
  assert.equal(triggers.schedule[0].cron, '17 4 * * *');
  assert.ok(Object.hasOwn(triggers, 'workflow_dispatch'));
  assert.deepEqual(workflow.permissions, { contents: 'write', actions: 'write' });
  assert.deepEqual(workflow.concurrency, {
    group: 'desktop-release-train',
    'cancel-in-progress': false,
  });
});

test('the workflow creates only a compatible main-history tag and dispatches the existing build', () => {
  const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.ok(checkout);
  assert.match(checkout.uses, /@[0-9a-f]{40}$/i);
  assert.equal(checkout.with['fetch-depth'], 0);

  const branchGuard = stepNamed('Require the default branch');
  assert.match(branchGuard.run, /GITHUB_REF_NAME/);
  assert.match(branchGuard.run, /default_branch/);
  assert.match(branchGuard.run, /exit 1/);

  const resolve = stepNamed('Resolve pending release');
  assert.equal(resolve.id, 'release');
  assert.match(resolve.run, /releases\/latest/);
  assert.match(resolve.run, /scripts\/resolve-desktop-release\.mjs/);
  assert.match(resolve.run, /HTTP 404/);
  assert.match(resolve.run, /exit "\$LATEST_STATUS"/);

  const tag = stepNamed('Create or verify release tag');
  assert.equal(tag.if, "steps.release.outputs.action == 'release'");
  assert.match(tag.run, /git ls-remote/);
  assert.match(tag.run, /git merge-base --is-ancestor/);
  assert.match(tag.run, /git rev-list -n 1/);
  assert.match(tag.run, /git show "\$TAG_SHA:package\.json"/);
  assert.match(tag.run, /TARGET_VERSION/);
  assert.match(tag.run, /RELEASE_SHA/);
  assert.match(tag.run, /git tag -a/);
  assert.match(tag.run, /git push origin "refs\/tags\/\$TAG"/);

  const dispatch = stepNamed('Dispatch desktop build');
  assert.equal(dispatch.if, "steps.release.outputs.action == 'release'");
  assert.match(dispatch.run, /gh workflow run build-desktop\.yml/);
  assert.match(dispatch.run, /--ref "\$TAG"/);
  assert.match(dispatch.run, /-f draft=false/);
  assert.doesNotMatch(workflowSource, /gh release create/);
  assert.doesNotMatch(workflowSource, /--no-verify/);
});

test('every workflow shell block parses after GitHub expression rendering', () => {
  for (const step of steps.filter((candidate) => candidate.run)) {
    const rendered = step.run.replace(/\$\{\{[^}]+\}\}/g, 'main');
    const result = spawnSync('bash', ['-n'], { input: rendered, encoding: 'utf8' });
    assert.equal(result.status, 0, `${step.name ?? '(unnamed)'}: ${result.stderr}`);
  }
});
