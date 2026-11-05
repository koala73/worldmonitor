import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import { createTempDir } from './helpers/temp-dir.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const retryScript = resolve(repoRoot, 'scripts/cf-rate-limit-retry.mjs');

// Wrangler's own wording for the failure that broke run 41960944579 on 2026-11-05.
const RATE_LIMITED =
  'A request to the Cloudflare API (/accounts/x/workers/services/api-cors-preflight) failed.\n' +
  '  Rate limited. Please wait and consider throttling your request speed [code: 10429]\n';

// A fake wrangler: reads a per-attempt plan from plan.json, records each call in calls.log.
function fakeCommand(dir, plan) {
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
  const script = join(dir, 'fake.mjs');
  writeFileSync(script, `
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = ${JSON.stringify(dir)};
const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
let n = 0;
try { n = readFileSync(join(dir, 'calls.log'), 'utf8').split('\\n').filter(Boolean).length; } catch {}
appendFileSync(join(dir, 'calls.log'), process.argv.slice(2).join(' ') + '\\n');
const step = plan[Math.min(n, plan.length - 1)];
if (step.stdout) process.stdout.write(step.stdout);
if (step.stderr) process.stderr.write(step.stderr);
process.exit(step.code);
`);
  return script;
}

function run(dir, plan, delays = '0,0,0') {
  const script = fakeCommand(dir, plan);
  const result = spawnSync(process.execPath, [retryScript, process.execPath, script, 'deploy', '--flag'], {
    encoding: 'utf8',
    env: { ...process.env, CF_RATE_LIMIT_RETRY_DELAYS_MS: delays },
  });
  const calls = existsSync(join(dir, 'calls.log'))
    ? readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean)
    : [];
  return { ...result, calls };
}

describe('cf-rate-limit-retry', () => {
  it('passes through a first-try success without retrying', () => {
    const dir = createTempDir('cf-retry-');
    const r = run(dir, [{ code: 0, stdout: 'Deployed api-cors-preflight\n' }]);
    assert.equal(r.status, 0);
    assert.deepEqual(r.calls, ['deploy --flag']);
    assert.match(r.stdout, /Deployed api-cors-preflight/);
  });

  it('retries a 10429 rate limit on stderr and succeeds', () => {
    const dir = createTempDir('cf-retry-');
    const r = run(dir, [{ code: 1, stderr: RATE_LIMITED }, { code: 0, stdout: 'Deployed\n' }]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.calls.length, 2);
    assert.match(r.stderr, /10429/);
    assert.match(r.stderr, /retrying in 0s \(attempt 2 of 4\)/);
  });

  it('retries a 10429 printed on stdout', () => {
    const dir = createTempDir('cf-retry-');
    const r = run(dir, [{ code: 1, stdout: RATE_LIMITED }, { code: 0 }]);
    assert.equal(r.status, 0);
    assert.equal(r.calls.length, 2);
  });

  it('actually waits the configured delay before retrying', () => {
    const dir = createTempDir('cf-retry-');
    const started = Date.now();
    const r = run(dir, [{ code: 1, stderr: RATE_LIMITED }, { code: 0 }], '400');
    const elapsed = Date.now() - started;
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.calls.length, 2);
    assert.ok(elapsed >= 400, `retried after ${elapsed} ms, expected at least 400 ms`);
  });

  it('defaults to a 15 s first backoff and keeps waiting rather than retrying at once', async () => {
    const dir = createTempDir('cf-retry-');
    const script = fakeCommand(dir, [{ code: 1, stderr: RATE_LIMITED }, { code: 0 }]);
    const env = { ...process.env };
    delete env.CF_RATE_LIMIT_RETRY_DELAYS_MS;
    const child = spawn(process.execPath, [retryScript, process.execPath, script, 'deploy'], { env });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => child.on('close', resolve));
    const deadline = Date.now() + 10_000;
    while (!stderr.includes('retrying in') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // Still inside the 15 s wait one second later: only the first attempt ran.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const calls = readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean);
    child.kill();
    await exited;
    assert.match(stderr, /retrying in 15s \(attempt 2 of 4\)/);
    assert.equal(calls.length, 1);
  });

  it('fails fast on a non-rate-limit error', () => {
    const dir = createTempDir('cf-retry-');
    const r = run(dir, [{ code: 1, stderr: 'Authentication error [code: 10000]\n' }, { code: 0 }]);
    assert.equal(r.status, 1);
    assert.equal(r.calls.length, 1);
  });

  it('gives up after the last delay and returns the command exit code', () => {
    const dir = createTempDir('cf-retry-');
    const r = run(dir, [{ code: 7, stderr: RATE_LIMITED }]);
    assert.equal(r.status, 7);
    assert.equal(r.calls.length, 4);
    assert.match(r.stderr, /still rate limited after 4 attempts/);
  });

  it('does not treat an exit-0 run that mentions 10429 as a failure', () => {
    const dir = createTempDir('cf-retry-');
    const r = run(dir, [{ code: 0, stderr: RATE_LIMITED }]);
    assert.equal(r.status, 0);
    assert.equal(r.calls.length, 1);
  });

  it('rejects an invalid delay list instead of silently not retrying', () => {
    const dir = createTempDir('cf-retry-');
    const r = run(dir, [{ code: 0 }], '15000,abc');
    assert.equal(r.status, 2);
    assert.equal(r.calls.length, 0);
    assert.match(r.stderr, /CF_RATE_LIMIT_RETRY_DELAYS_MS/);
  });

  it('exits 2 with usage when no command is given', () => {
    const r = spawnSync(process.execPath, [retryScript], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage/i);
  });
});

describe('deploy-worker.yml', () => {
  const workflow = YAML.parse(readFileSync(resolve(repoRoot, '.github/workflows/deploy-worker.yml'), 'utf8'));
  const deployStep = workflow.jobs.deploy.steps.find((step) => step.name === 'Deploy');

  it('runs wrangler deploy through the rate-limit retry wrapper', () => {
    assert.match(deployStep.run.trim(), /^node \.\.\/\.\.\/scripts\/cf-rate-limit-retry\.mjs npx wrangler deploy$/);
  });

  it('serializes deploys so a delayed retry cannot overwrite a newer deploy', () => {
    assert.equal(workflow.concurrency?.['cancel-in-progress'], false);
    assert.ok(workflow.concurrency?.group);
  });

  it('redeploys when the retry wrapper changes', () => {
    assert.ok(workflow.on.push.paths.includes('scripts/cf-rate-limit-retry.mjs'));
  });
});
