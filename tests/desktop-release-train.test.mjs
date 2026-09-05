import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
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
const clientEnv = Object.fromEntries([
  'VITE_CLERK_PUBLISHABLE_KEY', 'VITE_WS_RELAY_URL', 'VITE_PMTILES_URL_PUBLIC', 'CONVEX_URL',
].map((key) => [key, 'fixture-configured']));

function runPreparation({ env = clientEnv, runs = [], apiExit = 0, response = [{ workflow_runs: runs }] } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'wm-desktop-prepare-'));
  try {
    const bin = join(temp, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), [
      '#!/bin/sh',
      'if [ "$1" = "api" ]; then',
      '  echo api >> "$FAKE_CALLS"',
      '  [ "$FAKE_API_EXIT" = 0 ] || exit "$FAKE_API_EXIT"',
      '  printf \'%s\\n\' "$FAKE_RUNS"',
      'else',
      '  printf \'%s\\n\' "$*" >> "$FAKE_CALLS"',
      'fi',
    ].join('\n'));
    chmodSync(join(bin, 'gh'), 0o755);
    writeFileSync(join(temp, 'calls'), '');
    writeFileSync(join(temp, 'output'), '');
    const script = [
      'set -euo pipefail',
      stepNamed('Require release configuration').run,
      stepNamed('Check for an active desktop build').run,
      'if [ "$(sed -n \'s/^running=//p\' "$GITHUB_OUTPUT")" = false ]; then',
      stepNamed('Dispatch desktop build').run,
      'fi',
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'fixture/repository',
        GITHUB_OUTPUT: join(temp, 'output'),
        TAG: 'v2.10.0',
        FAKE_CALLS: join(temp, 'calls'),
        FAKE_API_EXIT: String(apiExit),
        FAKE_RUNS: JSON.stringify(response),
        ...env,
      },
      timeout: 10_000,
    });
    return { ...result, calls: readFileSync(join(temp, 'calls'), 'utf8').trim().split('\n').filter(Boolean) };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

test('preparation refuses every missing release secret before tag creation or dispatch', () => {
  const config = stepNamed('Require release configuration');
  assert.ok(steps.indexOf(config) < steps.indexOf(stepNamed('Create or verify release tag')));
  assert.equal(config.if, "steps.release.outputs.action == 'release'");
  for (const key of Object.keys(clientEnv)) {
    assert.equal(config.env[key], `\${{ secrets.${key} }}`);
    const result = runPreparation({ env: { ...clientEnv, [key]: '' } });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, new RegExp(key));
    assert.deepEqual(result.calls, []);
  }
});

test('preparation skips active builds and permits a configured retry after a completed failure', () => {
  for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    const result = runPreparation({ runs: [{ status }] });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, ['api']);
  }
  for (const runs of [[], [{ status: 'completed', conclusion: 'failure' }]]) {
    const result = runPreparation({ runs });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, ['api', 'workflow run build-desktop.yml --repo fixture/repository --ref v2.10.0 -f draft=false']);
  }
  const failedRead = runPreparation({ apiExit: 1 });
  assert.notEqual(failedRead.status, 0);
  assert.deepEqual(failedRead.calls, ['api']);
  const incompleteRead = runPreparation({ response: [{ message: 'unavailable' }] });
  assert.notEqual(incompleteRead.status, 0);
  assert.deepEqual(incompleteRead.calls, ['api']);
});

test('direct builds validate client configuration once before matrix expansion and preserve draft policy', () => {
  const desktop = loadYaml(readFileSync(resolve(root, '.github/workflows/build-desktop.yml'), 'utf8'));
  assert.equal(desktop.jobs['build-tauri'].needs, 'client-env');
  const job = desktop.jobs['client-env'];
  assert.equal(job.strategy, undefined);
  const preflight = job.steps.find((step) => step.name === 'Release client-env preflight (#5905)');
  assert.ok(preflight);
  assert.equal(desktop.jobs['build-tauri'].steps.some((step) => step.name === preflight.name), false);
  assert.deepEqual(preflight.env, stepNamed('Require release configuration').env);
  for (const [event, draft, env, success] of [
    ['push', 'false', {}, false],
    ['workflow_dispatch', 'false', {}, false],
    ['workflow_dispatch', 'true', {}, true],
    ['push', 'false', clientEnv, true],
  ]) {
    const script = preflight.run
      .replaceAll('${{ github.event_name }}', event)
      .replaceAll('${{ github.event.inputs.draft }}', draft);
    const result = spawnSync('bash', ['-e', '-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
    assert.equal(result.status === 0, success, result.stdout + result.stderr);
  }
});

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
  assert.equal(tag.if, "steps.release.outputs.action == 'release' && steps.active.outputs.running == 'false'");
  assert.match(tag.run, /git ls-remote/);
  assert.match(tag.run, /git merge-base --is-ancestor/);
  assert.match(tag.run, /git rev-list -n 1/);
  assert.match(tag.run, /git show "\$TAG_SHA:package\.json"/);
  assert.match(tag.run, /TARGET_VERSION/);
  assert.match(tag.run, /RELEASE_SHA/);
  assert.match(tag.run, /git tag -a/);
  assert.match(tag.run, /git push origin "refs\/tags\/\$TAG"/);

  const dispatch = stepNamed('Dispatch desktop build');
  assert.equal(dispatch.if, "steps.release.outputs.action == 'release' && steps.active.outputs.running == 'false'");
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
