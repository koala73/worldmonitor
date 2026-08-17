import { strict as assert } from 'node:assert';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { after, describe, test } from 'node:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCRIPT = join(REPO_ROOT, 'scripts', 'prepush-admission.mjs');
const FIXTURES = [];
const GIT_LOCAL_ENV_VARS = execFileSync('git', ['rev-parse', '--local-env-vars'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n');

function isolatedGitEnv() {
  const env = { ...process.env };
  for (const name of GIT_LOCAL_ENV_VARS) delete env[name];
  return env;
}

after(() => {
  for (const fixture of FIXTURES) rmSync(fixture, { recursive: true, force: true });
});

function commonDir() {
  const dir = mkdtempSync(join(tmpdir(), 'wm-prepush-admission-'));
  FIXTURES.push(dir);
  return dir;
}

function run(mode, dir, lease, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, mode, dir, ...(lease ? [lease] : [])], {
    encoding: 'utf8',
    env: {
      ...process.env,
      WM_PREPUSH_ADMISSION_MAX: '2',
      WM_PREPUSH_ADMISSION_POLL_MS: '10',
      WM_PREPUSH_ADMISSION_WAIT_MS: '80',
      WM_PREPUSH_ADMISSION_STALE_MS: '20',
      ...env,
    },
  });
}

function acquire(dir, env) {
  const result = run('acquire', dir, null, env);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function release(dir, lease) {
  const result = run('release', dir, lease);
  assert.equal(result.status, 0, result.stderr);
}

function slots(dir) {
  const root = join(dir, 'wm-prepush-admission');
  try {
    return readdirSync(root).filter((entry) => /^slot-[1-9]\d*$/.test(entry));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

describe('pre-push heavy-phase admission', () => {
  test('five linked worktrees never occupy more than two heavy-phase slots', async () => {
    const dir = commonDir();
    const repo = join(dir, 'repo');
    const gitEnv = isolatedGitEnv();
    mkdirSync(repo);
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', '.'], { cwd: repo, env: gitEnv });
    execFileSync('git', ['config', 'user.email', 'prepush-admission@example.invalid'], { cwd: repo, env: gitEnv });
    execFileSync('git', ['config', 'user.name', 'Prepush Admission Fixture'], { cwd: repo, env: gitEnv });
    execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'base'], { cwd: repo, env: gitEnv });
    const worktrees = Array.from({ length: 5 }, (_, index) => join(dir, `worktree-${index + 1}`));
    for (const worktree of worktrees) {
      execFileSync('git', ['worktree', 'add', '--quiet', '--detach', worktree, 'HEAD'], {
        cwd: repo,
        env: gitEnv,
      });
    }

    const worker = join(dir, 'worker.mjs');
    writeFileSync(
      worker,
      `import { execFileSync, spawnSync } from 'node:child_process';\n` +
        `const [script] = process.argv.slice(2);\n` +
        `const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();\n` +
        `const acquire = spawnSync(process.execPath, [script, 'acquire', commonDir], { encoding: 'utf8', env: process.env });\n` +
        `if (acquire.status !== 0) { console.error(acquire.stderr); process.exit(acquire.status ?? 1); }\n` +
        `await new Promise((resolve) => setTimeout(resolve, 120));\n` +
        `const release = spawnSync(process.execPath, [script, 'release', commonDir, acquire.stdout.trim()], { encoding: 'utf8', env: process.env });\n` +
        `if (release.status !== 0) { console.error(release.stderr); process.exit(release.status ?? 1); }\n`,
    );

    const env = {
      ...gitEnv,
      WM_PREPUSH_ADMISSION_MAX: '2',
      WM_PREPUSH_ADMISSION_POLL_MS: '10',
      WM_PREPUSH_ADMISSION_WAIT_MS: String(2_000),
      WM_PREPUSH_ADMISSION_STALE_MS: '500',
    };
    const children = worktrees.map((worktree) => spawn(process.execPath, [worker, SCRIPT], {
      cwd: worktree,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));

    let maxSlots = 0;
    const sample = setInterval(() => {
      maxSlots = Math.max(maxSlots, slots(join(repo, '.git')).length);
    }, 5);
    const results = await Promise.all(children.map((child) => new Promise((resolveChild) => {
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (status) => resolveChild({ status, stderr }));
    })));
    clearInterval(sample);

    assert.deepEqual(results.map(({ status }) => status), [0, 0, 0, 0, 0], JSON.stringify(results));
    assert.equal(maxSlots, 2, 'five callers must queue behind exactly two admission slots');
    assert.deepEqual(slots(join(repo, '.git')), []);
  });

  test('admits only the configured number of hooks and queues the next one', () => {
    const dir = commonDir();
    const first = acquire(dir);
    const second = acquire(dir);

    assert.equal(slots(dir).length, 2);
    const blocked = run('acquire', dir);
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /Timed out waiting for a pre-push heavy-phase slot/);

    release(dir, first);
    const replacement = acquire(dir);
    assert.equal(slots(dir).length, 2);

    release(dir, second);
    release(dir, replacement);
    assert.deepEqual(slots(dir), []);
  });

  test('a lease token cannot release another hook owner', () => {
    const dir = commonDir();
    const lease = acquire(dir);
    const parsed = JSON.parse(lease);
    const forged = JSON.stringify({ ...parsed, token: 'not-the-owner' });

    const result = run('release', dir, forged);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not own/);
    assert.equal(slots(dir).length, 1);

    release(dir, lease);
  });

  test('reclaims a stale slot left by a crashed hook', () => {
    const dir = commonDir();
    const root = join(dir, 'wm-prepush-admission');
    const slot = join(root, 'slot-1');
    mkdirSync(slot, { recursive: true });
    writeFileSync(
      join(slot, 'owner.json'),
      `${JSON.stringify({ acquiredAt: Date.now() - 60_000, pid: 999_999_999, token: 'crashed' })}\n`,
    );
    const staleTime = new Date(Date.now() - 60_000);
    utimesSync(slot, staleTime, staleTime);

    const lease = acquire(dir);
    assert.equal(JSON.parse(lease).slotPath, realpathSync(slot));
    assert.equal(slots(dir).length, 1);
    release(dir, lease);
  });

  test('reclaims a stale mkdir left before its owner record was written', () => {
    const dir = commonDir();
    const slot = join(dir, 'wm-prepush-admission', 'slot-1');
    mkdirSync(slot, { recursive: true });
    const staleTime = new Date(Date.now() - 60_000);
    utimesSync(slot, staleTime, staleTime);

    const lease = acquire(dir, { WM_PREPUSH_ADMISSION_MAX: '1' });
    assert.equal(JSON.parse(lease).slotPath, realpathSync(slot));
    release(dir, lease);
  });

  test('reclaims a stale malformed owner record using its exact bytes', () => {
    const dir = commonDir();
    const slot = join(dir, 'wm-prepush-admission', 'slot-1');
    mkdirSync(slot, { recursive: true });
    writeFileSync(join(slot, 'owner.json'), '{"pid":');
    const staleTime = new Date(Date.now() - 60_000);
    utimesSync(slot, staleTime, staleTime);

    const lease = acquire(dir, { WM_PREPUSH_ADMISSION_MAX: '1' });
    assert.equal(JSON.parse(lease).slotPath, realpathSync(slot));
    release(dir, lease);
  });

  test('concurrent stale reclaim does not abort waiters or exceed the cap', async () => {
    const dir = commonDir();
    const slot = join(dir, 'wm-prepush-admission', 'slot-1');
    mkdirSync(slot, { recursive: true });
    writeFileSync(
      join(slot, 'owner.json'),
      `${JSON.stringify({ acquiredAt: Date.now() - 60_000, pid: 999_999_999, token: 'crashed' })}\n`,
    );
    const staleTime = new Date(Date.now() - 60_000);
    utimesSync(slot, staleTime, staleTime);

    const env = {
      ...process.env,
      WM_PREPUSH_ADMISSION_MAX: '1',
      WM_PREPUSH_ADMISSION_POLL_MS: '10',
      WM_PREPUSH_ADMISSION_WAIT_MS: String(2_000),
      WM_PREPUSH_ADMISSION_STALE_MS: '20',
    };
    const worker = join(dir, 'reclaim-worker.mjs');
    writeFileSync(
      worker,
      `import { spawnSync } from 'node:child_process';\n` +
        `const [script, commonDir] = process.argv.slice(2);\n` +
        `const acquire = spawnSync(process.execPath, [script, 'acquire', commonDir], { encoding: 'utf8', env: process.env });\n` +
        `if (acquire.status !== 0) { console.error(acquire.stderr); process.exit(acquire.status ?? 1); }\n` +
        `await new Promise((resolve) => setTimeout(resolve, 80));\n` +
        `const release = spawnSync(process.execPath, [script, 'release', commonDir, acquire.stdout.trim()], { encoding: 'utf8', env: process.env });\n` +
        `if (release.status !== 0) { console.error(release.stderr); process.exit(release.status ?? 1); }\n`,
    );
    const children = Array.from({ length: 3 }, () => spawn(process.execPath, [worker, SCRIPT, dir], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));

    let maxSlots = 0;
    const sample = setInterval(() => {
      maxSlots = Math.max(maxSlots, slots(dir).length);
    }, 5);
    const results = await Promise.all(children.map((child) => new Promise((resolveChild) => {
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (status) => resolveChild({ status, stderr }));
    })));
    clearInterval(sample);

    assert.deepEqual(results.map(({ status }) => status), [0, 0, 0], JSON.stringify(results));
    assert.equal(
      results.some(({ stderr }) => stderr.includes('changed owner')),
      false,
      JSON.stringify(results),
    );
    assert.ok(maxSlots <= 1, `concurrent reclaim must not exceed the cap (saw ${maxSlots})`);
    assert.deepEqual(slots(dir), []);
  });

  test('never reclaims an old slot while its owner process is alive', () => {
    const dir = commonDir();
    const slot = join(dir, 'wm-prepush-admission', 'slot-1');
    mkdirSync(slot, { recursive: true });
    writeFileSync(
      join(slot, 'owner.json'),
      `${JSON.stringify({ acquiredAt: Date.now() - 3_600_000, pid: process.pid, token: 'live' })}\n`,
    );
    const staleTime = new Date(Date.now() - 3_600_000);
    utimesSync(slot, staleTime, staleTime);

    const result = run('acquire', dir, null, { WM_PREPUSH_ADMISSION_MAX: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Timed out waiting for a pre-push heavy-phase slot/);
    assert.equal(readFileSync(join(slot, 'owner.json'), 'utf8').includes('"token":"live"'), true);
  });

  test('rejects unsafe numeric configuration', () => {
    const dir = commonDir();
    const result = run('acquire', dir, null, { WM_PREPUSH_ADMISSION_MAX: 'all' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /WM_PREPUSH_ADMISSION_MAX must be a positive integer/);

    const unsafe = run('acquire', dir, null, {
      WM_PREPUSH_ADMISSION_MAX: '999999999999999999999',
    });
    assert.equal(unsafe.status, 2);
    assert.match(unsafe.stderr, /WM_PREPUSH_ADMISSION_MAX must be a positive integer/);
  });
});
