import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  CROSS_STRAIT_ONE_OFF_REQUIREMENTS,
  HISTORY_POSTFLIGHT_PROGRAM,
  SANDBOX_PREFLIGHT_PROGRAM,
  SANDBOX_SEED_PROGRAM,
  SEED_SUPERVISOR_PROGRAM,
  buildSandboxCreateArgs,
  createRailwayExecutor,
  formatCliError,
  runCrossStraitHistoryOneOff,
  validateHistoryPostflightRecord,
} from '../scripts/run-cross-strait-history-one-off.mjs';

const DEPLOYED_COMMIT = '3edc968450faa7f38749c5b42cde901c1e038e52';
const COMPLETE_ENV = {
  UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
  UPSTASH_REDIS_REST_TOKEN: 'upstash-secret-value',
  PROXY_URL: 'https://proxy-user:proxy-secret@example.test',
  CONVEX_URL: 'https://example.convex.cloud',
  RELAY_SHARED_SECRET: 'relay-secret-value',
  OPENROUTER_API_KEY: 'openrouter-secret-value',
  WM_ONE_OFF_DEPLOYED_COMMIT: DEPLOYED_COMMIT,
};

function runPreflight(env) {
  return spawnSync(process.execPath, ['--eval', SANDBOX_PREFLIGHT_PROGRAM], {
    encoding: 'utf8',
    env,
  });
}

function runCli(args) {
  return spawnSync(process.execPath, [
    new URL('../scripts/run-cross-strait-history-one-off.mjs', import.meta.url).pathname,
    ...args,
  ], { encoding: 'utf8' });
}

function sandboxIdFromCreateArgs(args) {
  const index = args.indexOf('--id');
  return index === -1 ? null : args[index + 1];
}

describe('Cross-Strait history Railway one-off', () => {
  it('rejects the incident partial environment before the seeder command is reached', async () => {
    const incidentEnv = {
      UPSTASH_REDIS_REST_URL: COMPLETE_ENV.UPSTASH_REDIS_REST_URL,
      UPSTASH_REDIS_REST_TOKEN: COMPLETE_ENV.UPSTASH_REDIS_REST_TOKEN,
      PROXY_URL: COMPLETE_ENV.PROXY_URL,
      WM_ONE_OFF_DEPLOYED_COMMIT: DEPLOYED_COMMIT,
    };
    const preflight = runPreflight(incidentEnv);

    assert.equal(preflight.status, 78);
    assert.match(preflight.stdout, /CONVEX_SITE_URL or CONVEX_URL/);
    assert.match(preflight.stdout, /RELAY_SHARED_SECRET/);
    assert.match(preflight.stdout, /OPENROUTER_API_KEY/);
    for (const value of Object.values(incidentEnv)) {
      assert.doesNotMatch(`${preflight.stdout}${preflight.stderr}`, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }

    const stages = [];
    await assert.rejects(
      runCrossStraitHistoryOneOff({
        project: 'project-1',
        environment: 'production',
        executeRailway: (_args, { stage }) => {
          stages.push(stage);
          if (stage === 'create') return JSON.stringify({ id: 'sandbox-incident' });
          if (stage === 'preflight') throw new Error('Railway preflight failed (exit 78); remote output suppressed');
          return '';
        },
        log: () => {},
      }),
      /preflight failed/,
    );

    assert.deepEqual(stages, ['create', 'preflight', 'cleanup']);
  });

  it('passes only server-side service references and the deployed revision reference', () => {
    const args = buildSandboxCreateArgs({
      project: 'project-1',
      environment: 'production',
    });
    const variableArgs = args
      .map((arg, index) => (args[index - 1] === '--variable' ? arg : null))
      .filter(Boolean);

    assert.equal(variableArgs.length, CROSS_STRAIT_ONE_OFF_REQUIREMENTS.flatMap((group) => group.names).length + 1);
    assert.ok(variableArgs.includes(
      'WM_ONE_OFF_DEPLOYED_COMMIT=seed-bundle-derived-signals.RAILWAY_GIT_COMMIT_SHA',
    ));
    for (const group of CROSS_STRAIT_ONE_OFF_REQUIREMENTS) {
      for (const name of group.names) {
        assert.ok(variableArgs.includes(`${name}=seed-bundle-derived-signals.${name}`));
      }
    }
    assert.ok(variableArgs.every((value) => !Object.values(COMPLETE_ENV).includes(value.split('=')[1])));
  });

  it('accepts the complete contract without printing secret values', () => {
    const result = runPreflight(COMPLETE_ENV);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(DEPLOYED_COMMIT));
    for (const secret of [
      COMPLETE_ENV.UPSTASH_REDIS_REST_TOKEN,
      COMPLETE_ENV.PROXY_URL,
      COMPLETE_ENV.RELAY_SHARED_SECRET,
      COMPLETE_ENV.OPENROUTER_API_KEY,
    ]) {
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  it('rejects unresolved references and malformed deployed revisions', () => {
    const unresolved = runPreflight({
      ...COMPLETE_ENV,
      OPENROUTER_API_KEY: '${{seed-bundle-derived-signals.OPENROUTER_API_KEY}}',
    });
    assert.equal(unresolved.status, 78);
    assert.match(unresolved.stdout, /OPENROUTER_API_KEY/);

    const malformedCommit = runPreflight({
      ...COMPLETE_ENV,
      WM_ONE_OFF_DEPLOYED_COMMIT: 'main',
    });
    assert.equal(malformedCommit.status, 78);
    assert.match(malformedCommit.stdout, /WM_ONE_OFF_DEPLOYED_COMMIT/);
  });

  it('rejects an unusable preferred alias even when its fallback is valid', () => {
    for (const override of [
      { JAPAN_MOD_PROXY_URL: '${{seed-bundle-derived-signals.JAPAN_MOD_PROXY_URL}}' },
      { CONVEX_SITE_URL: '   ' },
    ]) {
      const result = runPreflight({ ...COMPLETE_ENV, ...override });
      assert.equal(result.status, 78);
    }
  });

  it('reaches the exact-revision seeder only after preflight and cleans up on success', async () => {
    const calls = [];
    await runCrossStraitHistoryOneOff({
      project: 'project-1',
      environment: 'production',
      executeRailway: (args, { stage }) => {
        calls.push({ args, stage });
        return stage === 'create' ? JSON.stringify({ id: 'sandbox-complete' }) : '';
      },
      log: () => {},
    });

    assert.deepEqual(calls.map(({ stage }) => stage), ['create', 'preflight', 'seed', 'cleanup']);
    const seedCall = calls.find(({ stage }) => stage === 'seed');
    assert.equal(sandboxIdFromCreateArgs(seedCall.args), 'sandbox-complete');
    assert.match(
      seedCall.args.at(-1),
      /git -C "\$workspace" fetch --quiet --depth=1 origin "\$WM_ONE_OFF_DEPLOYED_COMMIT"/,
    );
    assert.match(seedCall.args.at(-1), /git -C "\$workspace" checkout --quiet --detach FETCH_HEAD/);
    assert.match(seedCall.args.at(-1), /actual_commit="\$\(git -C "\$workspace" rev-parse HEAD 2>\/dev\/null\)"/);
    assert.match(seedCall.args.at(-1), /if \[ "\$actual_commit" != "\$WM_ONE_OFF_DEPLOYED_COMMIT" \]/);
    assert.match(seedCall.args.at(-1), /seed-cross-strait-activity\.mjs/);
    assert.match(seedCall.args.at(-1), /WM_ONE_OFF_HISTORY_RECEIPT=1 node --eval/);
  });

  it('turns a fail-open seeder lock skip into a failed one-off', () => {
    assert.match(SANDBOX_SEED_PROGRAM, /SKIPPED: Redis unavailable during lock acquisition.*seed_lock_unavailable/s);
    assert.match(SANDBOX_SEED_PROGRAM, /SKIPPED: another seed run in progress.*seed_already_running/s);
    assert.match(SANDBOX_SEED_PROGRAM, /SKIPPED: validation failed.*seed_validation_failed/s);
    assert.match(SANDBOX_SEED_PROGRAM, /NO SOURCE:.*seed_no_source/s);
    assert.match(SANDBOX_SEED_PROGRAM, /RETRY:.*seed_incomplete/s);
    assert.match(SANDBOX_SEED_PROGRAM, /reject_seed seed_process_failed "\$exit_code"/);
  });

  it('requires a lossless same-run history ingest postflight', () => {
    const healthy = {
      state: 'healthy',
      lastRunId: 'run-42',
      lastChunks: 1,
      lastAbandoned: 0,
      lastFailedChunks: 0,
      lastInputRecords: 10,
      lastNormalizedRecords: 10,
      lastDroppedRecords: 0,
      lastAcceptedRecords: 8,
      lastInserted: 6,
      lastDeduped: 2,
      lastRetracted: 2,
    };
    assert.doesNotThrow(() => validateHistoryPostflightRecord(healthy, 'run-42'));
    assert.doesNotThrow(() => validateHistoryPostflightRecord({
      ...healthy,
      lastChunks: 8,
      lastInputRecords: 367,
      lastNormalizedRecords: 367,
      lastDroppedRecords: 0,
      lastAcceptedRecords: 367,
      lastInserted: 367,
      lastDeduped: 0,
      lastRetracted: 0,
    }, 'run-42'));
    for (const record of [
      { ...healthy, lastRunId: 'run-41' },
      { ...healthy, state: 'failing' },
      { ...healthy, lastChunks: 0 },
      { ...healthy, lastAbandoned: 1 },
      { ...healthy, lastFailedChunks: 1 },
      { ...healthy, lastAbandoned: null },
      { ...healthy, lastAbandoned: false },
      { ...healthy, lastAbandoned: '0' },
      { ...healthy, lastFailedChunks: '' },
      { ...healthy, lastDroppedRecords: 1 },
      { ...healthy, lastInputRecords: 11 },
      { ...healthy, lastNormalizedRecords: 11 },
      { ...healthy, lastAcceptedRecords: 7 },
      { ...healthy, lastInserted: -1, lastDeduped: 9 },
      { ...healthy, lastInserted: 7, lastDeduped: 2, lastAcceptedRecords: 8 },
      { ...healthy, lastRetracted: null },
    ]) {
      assert.throws(() => validateHistoryPostflightRecord(record, 'run-42'));
    }
    assert.match(
      HISTORY_POSTFLIGHT_PROGRAM,
      /intel-history:ingest-health:military:cross-strait-activity:v1:run:' \+ runId/,
    );
    assert.match(HISTORY_POSTFLIGHT_PROGRAM, /'User-Agent': 'WorldMonitor-Cross-Strait-One-Off\/1\.0'/);
    assert.match(SANDBOX_SEED_PROGRAM, /WM_ONE_OFF_HISTORY_RECEIPT=1 node --eval/);
    assert.match(SANDBOX_SEED_PROGRAM, /node --eval [\s\S]* "\$run_id"/);
    const syntax = spawnSync('/bin/sh', ['-n'], { input: SANDBOX_SEED_PROGRAM, encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
  });

  it('executes the sandbox seed program through its revision, outcome, and postflight gates', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cross-strait-seed-program-'));
    const workspaceMarker = join(tempDir, 'workspace');
    const postflightMarker = join(tempDir, 'postflight');
    const outputLimitTermMarker = join(tempDir, 'output-limit-term');
    const writeExecutable = (name, source) => {
      const path = join(tempDir, name);
      writeFileSync(path, `#!/bin/sh\n${source}\n`);
      chmodSync(path, 0o755);
    };
    writeExecutable('git', `
if [ "$1" = "init" ]; then printf '%s' "$3" > ${JSON.stringify(workspaceMarker)}; fi
if [ "$1" = "-C" ] && [ "$3" = "checkout" ]; then mkdir -p "$2/scripts"; fi
if [ "$3" = "rev-parse" ]; then printf '%s\\n' "$FAKE_GIT_COMMIT"; fi
exit 0`);
    writeExecutable('npm', 'exit 0');
    writeExecutable('node', `
if [ "$1" = "--eval" ] && [ "$#" -eq 5 ]; then
  exec ${JSON.stringify(process.execPath)} "$@"
fi
if [ "$1" = "seed-cross-strait-activity.mjs" ]; then
  if [ "\${FAKE_SEED_FLOOD:-}" = "1" ]; then
    trap 'printf terminated > "$FAKE_SEED_TERM_MARKER"; exit 143' TERM
    while :; do printf '%01024d' 0; done
  fi
  printf '  Run ID:  run-42\\n'
  if [ -n "\${FAKE_SEED_MARKER:-}" ]; then printf '%s\\n' "$FAKE_SEED_MARKER"; fi
  exit 0
fi
if [ "\${FAKE_POSTFLIGHT_FAIL:-}" = "1" ]; then exit 1; fi
printf '%s' "$3" > ${JSON.stringify(postflightMarker)}
exit 0`);

    const runProgram = (overrides = {}) => spawnSync('/bin/sh', ['-c', SANDBOX_SEED_PROGRAM], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH}`,
        WM_ONE_OFF_DEPLOYED_COMMIT: DEPLOYED_COMMIT,
        FAKE_GIT_COMMIT: DEPLOYED_COMMIT,
        ...overrides,
      },
    });

    try {
      const success = runProgram();
      assert.equal(success.status, 0, success.stderr);
      assert.equal(readFileSync(postflightMarker, 'utf8'), 'run-42');
      assert.equal(existsSync(readFileSync(workspaceMarker, 'utf8')), false);

      for (const marker of [
        'SKIPPED: another seed run in progress',
        'SKIPPED: validation failed (empty/partial fetch)',
        'NO SOURCE: no usable upstream',
        'RETRY: declareRecords returned 0',
      ]) {
        rmSync(postflightMarker, { force: true });
        const rejected = runProgram({ FAKE_SEED_MARKER: marker });
        assert.equal(rejected.status, 75, marker);
        assert.equal(existsSync(postflightMarker), false, marker);
      }

      const excessiveOutput = runProgram({
        FAKE_SEED_FLOOD: '1',
        FAKE_SEED_TERM_MARKER: outputLimitTermMarker,
      });
      assert.notEqual(excessiveOutput.status, 0);
      assert.equal(existsSync(postflightMarker), false);
      assert.equal(readFileSync(outputLimitTermMarker, 'utf8'), 'terminated');
      assert.match(SEED_SUPERVISOR_PROGRAM, /const limit = 1024 \* 1024/);

      const wrongRevision = runProgram({ FAKE_GIT_COMMIT: '0'.repeat(40) });
      assert.equal(wrongRevision.status, 78);

      const failedPostflight = runProgram({ FAKE_POSTFLIGHT_FAIL: '1' });
      assert.equal(failedPostflight.status, 1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps the lock-skip detector aligned with the shared seeder messages', () => {
    const seedUtils = readFileSync(new URL('../scripts/_seed-utils.mjs', import.meta.url), 'utf8');

    assert.match(seedUtils, /SKIPPED: Redis unavailable during lock acquisition/);
    assert.match(seedUtils, /SKIPPED: another seed run in progress/);
  });

  it('caps the supervised seeder output at one private mebibyte', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cross-strait-output-cap-'));
    const fakeNode = join(tempDir, 'node');
    const output = join(tempDir, 'seed.log');
    const overflow = join(tempDir, 'overflow');
    writeFileSync(fakeNode, `#!/bin/sh
trap 'exit 143' TERM
while :; do printf '%01024d' 0; done
`);
    chmodSync(fakeNode, 0o755);

    try {
      const result = spawnSync(process.execPath, [
        '--eval', SEED_SUPERVISOR_PROGRAM, output, overflow, 'supervisor',
      ], {
        env: { ...process.env, PATH: `${tempDir}:${process.env.PATH}` },
        timeout: 10_000,
      });

      assert.equal(result.status, 75, result.stderr?.toString());
      assert.equal(statSync(output).size, 1024 * 1024);
      assert.equal(statSync(output).mode & 0o777, 0o600);
      assert.equal(existsSync(overflow), true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('cleans up when the seeder command fails', async () => {
    const stages = [];
    await assert.rejects(
      runCrossStraitHistoryOneOff({
        project: 'project-1',
        environment: 'production',
        executeRailway: (_args, { stage }) => {
          stages.push(stage);
          if (stage === 'create') return JSON.stringify({ id: 'sandbox-failed-seed' });
          if (stage === 'seed') throw new Error('Railway seed failed (exit 1); remote output suppressed');
          return '';
        },
        log: () => {},
      }),
      /seed failed/,
    );

    assert.deepEqual(stages, ['create', 'preflight', 'seed', 'cleanup']);
  });

  it('cleans up and fails when interrupted after sandbox creation', async () => {
    const stages = [];
    const processSignals = new EventEmitter();
    await assert.rejects(
      runCrossStraitHistoryOneOff({
        project: 'project-1',
        environment: 'production',
        processSignals,
        executeRailway: (_args, { stage }) => {
          stages.push(stage);
          if (stage === 'create') return JSON.stringify({ id: 'sandbox-interrupted' });
          if (stage === 'preflight') processSignals.emit('SIGHUP', 'SIGHUP');
          return '';
        },
        log: () => {},
      }),
      /SIGHUP received; stopping before the seeder/,
    );

    assert.deepEqual(stages, ['create', 'preflight', 'cleanup']);
    assert.equal(processSignals.listenerCount('SIGHUP'), 0);
    assert.equal(processSignals.listenerCount('SIGINT'), 0);
    assert.equal(processSignals.listenerCount('SIGTERM'), 0);
  });

  it('stops before preflight when interrupted during sandbox creation', async () => {
    const stages = [];
    const processSignals = new EventEmitter();
    await assert.rejects(
      runCrossStraitHistoryOneOff({
        project: 'project-1',
        environment: 'production',
        processSignals,
        executeRailway: (_args, { stage }) => {
          stages.push(stage);
          if (stage === 'create') {
            processSignals.emit('SIGINT', 'SIGINT');
            return JSON.stringify({ id: 'sandbox-create-interrupted' });
          }
          return '';
        },
        log: () => {},
      }),
      /SIGINT received; stopping before sandbox preflight/,
    );
    assert.deepEqual(stages, ['create', 'cleanup']);
  });

  it('keeps cleanup controlled when a second signal arrives during destroy', async () => {
    const stages = [];
    const processSignals = new EventEmitter();
    await assert.rejects(
      runCrossStraitHistoryOneOff({
        project: 'project-1',
        environment: 'production',
        processSignals,
        executeRailway: (_args, { stage }) => {
          stages.push(stage);
          if (stage === 'create') return JSON.stringify({ id: 'sandbox-second-signal' });
          if (stage === 'preflight') processSignals.emit('SIGTERM', 'SIGTERM');
          if (stage === 'cleanup') processSignals.emit('SIGINT', 'SIGINT');
          return '';
        },
        log: () => {},
      }),
      /SIGTERM received; stopping before the seeder/,
    );
    assert.deepEqual(stages, ['create', 'preflight', 'cleanup']);
    assert.equal(processSignals.listenerCount('SIGINT'), 0);
    assert.equal(processSignals.listenerCount('SIGTERM'), 0);
  });

  it('does not interrupt cleanup when the first signal arrives during destroy', async () => {
    const stages = [];
    const processSignals = new EventEmitter();
    const executeRailway = (_args, { stage }) => {
      stages.push(stage);
      if (stage === 'create') return JSON.stringify({ id: 'sandbox-cleanup-signal' });
      if (stage === 'cleanup') {
        processSignals.emit('SIGTERM', 'SIGTERM');
        processSignals.emit('SIGTERM', 'SIGTERM');
      }
      return '';
    };
    let interrupts = 0;
    executeRailway.interrupt = () => {
      interrupts += 1;
    };

    await assert.rejects(
      runCrossStraitHistoryOneOff({
        project: 'project-1',
        environment: 'production',
        processSignals,
        executeRailway,
        log: () => {},
      }),
      /SIGTERM received; sandbox was cleaned up before exit/,
    );

    assert.deepEqual(stages, ['create', 'preflight', 'seed', 'cleanup']);
    assert.equal(interrupts, 0);
    assert.equal(processSignals.listenerCount('SIGTERM'), 0);
  });

  it('does not report successful cleanup when a signal and destroy failure coincide', async () => {
    const processSignals = new EventEmitter();
    const executeRailway = (_args, { stage }) => {
      if (stage === 'create') return JSON.stringify({ id: 'sandbox-cleanup-signal-failure' });
      if (stage === 'cleanup') {
        processSignals.emit('SIGTERM', 'SIGTERM');
        throw new Error('cleanup failed');
      }
      return '';
    };

    await assert.rejects(
      runCrossStraitHistoryOneOff({
        project: 'project-1',
        environment: 'production',
        processSignals,
        executeRailway,
        log: () => {},
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.match(formatCliError(error), /SIGTERM received during sandbox cleanup; cleanup failed/);
        assert.doesNotMatch(formatCliError(error), /was cleaned up/);
        return true;
      },
    );
  });

  it('reports cleanup failure and retains the server timeout backstop', async () => {
    const stages = [];
    await assert.rejects(
      runCrossStraitHistoryOneOff({
        project: 'project-1',
        environment: 'production',
        executeRailway: (_args, { stage }) => {
          stages.push(stage);
          if (stage === 'create') return JSON.stringify({ id: 'sandbox-cleanup-failure' });
          if (stage === 'cleanup') throw new Error('Railway cleanup failed; remote output suppressed');
          return '';
        },
        log: () => {},
      }),
      /cleanup failed/,
    );
    assert.deepEqual(stages, ['create', 'preflight', 'seed', 'cleanup']);
  });

  it('leaves cleanup to the idle timeout when create returns no sandbox ID', async () => {
    const stages = [];
    await assert.rejects(
      runCrossStraitHistoryOneOff({
        project: 'project-1',
        environment: 'production',
        executeRailway: (_args, { stage }) => {
          stages.push(stage);
          return JSON.stringify({ status: 'created-without-id' });
        },
        log: () => {},
      }),
      /no valid sandbox ID; the 15-minute server idle timeout remains active/,
    );
    assert.deepEqual(stages, ['create']);
  });

  it('preserves both the seed and cleanup failures', async () => {
    await assert.rejects(
      runCrossStraitHistoryOneOff({
        project: 'project-1',
        environment: 'production',
        executeRailway: (_args, { stage }) => {
          if (stage === 'create') return JSON.stringify({ id: 'sandbox-double-failure' });
          if (stage === 'seed') throw new Error('seed failed');
          if (stage === 'cleanup') throw new Error('cleanup failed');
          return '';
        },
        log: () => {},
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.match(error.message, /server idle timeout remains active/);
        assert.match(formatCliError(error), /seed failed; cleanup failed/);
        return true;
      },
    );
  });

  it('suppresses Railway stderr so secrets cannot enter local output', async () => {
    const marker = 'secret-returned-by-remote-process';
    let spawnOptions;
    const execute = createRailwayExecutor((_command, _args, options) => {
      spawnOptions = options;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.kill = () => true;
      queueMicrotask(() => {
        child.stdout.emit('data', `${marker}\n`);
        child.stdout.emit('data', '__WM_ONE_OFF_PREFLIGHT__{"status":"rejected","missing":["OPENROUTER_API_KEY","secret-name"]}\n');
        child.emit('close', 78, null);
      });
      return child;
    });

    await assert.rejects(
      execute(['sandbox', 'exec'], { stage: 'preflight', timeoutMs: 1_000 }),
      (error) => {
        assert.doesNotMatch(error.message, new RegExp(marker));
        assert.doesNotMatch(error.message, /secret-name/);
        assert.match(error.message, /missing OPENROUTER_API_KEY/);
        assert.match(error.message, /remote output suppressed/);
        return true;
      },
    );
    assert.deepEqual(spawnOptions.stdio, ['ignore', 'pipe', 'ignore']);
    assert.equal('maxBuffer' in spawnOptions, false);
  });

  it('surfaces only an allowlisted seed failure reason', async () => {
    const secret = 'secret-returned-by-remote-process';
    let spawnOptions;
    const execute = createRailwayExecutor((_command, _args, options) => {
      spawnOptions = options;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.kill = () => true;
      queueMicrotask(() => {
        child.stdout.emit('data', `${secret}\n`);
        child.stdout.emit('data', '__WM_ONE_OFF_SEED__{"status":"rejected","code":"history_postflight_failed"}\n');
        child.emit('close', 75, null);
      });
      return child;
    });

    await assert.rejects(
      execute(['sandbox', 'exec'], { stage: 'seed', timeoutMs: 1_000 }),
      (error) => {
        assert.match(error.message, /reason history_postflight_failed/);
        assert.doesNotMatch(error.message, new RegExp(secret));
        assert.match(error.message, /remote output suppressed/);
        return true;
      },
    );
    assert.deepEqual(spawnOptions.stdio, ['ignore', 'pipe', 'ignore']);
  });

  it('requires the fixed accepted marker even when Railway exits zero', async () => {
    const execute = createRailwayExecutor(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.kill = () => true;
      queueMicrotask(() => {
        child.stdout.emit('data', 'untrusted successful-looking output\n');
        child.emit('close', 0, null);
      });
      return child;
    });

    await assert.rejects(
      execute(['sandbox', 'exec'], { stage: 'seed', timeoutMs: 1_000 }),
      /seed returned no accepted status; remote output suppressed/,
    );
  });

  it('does not surface a non-allowlisted seed marker code', async () => {
    const secretCode = 'secret_remote_failure_detail';
    const execute = createRailwayExecutor(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.kill = () => true;
      queueMicrotask(() => {
        child.stdout.emit(
          'data',
          `__WM_ONE_OFF_SEED__{"status":"rejected","code":"${secretCode}"}\n`,
        );
        child.emit('close', 75, null);
      });
      return child;
    });

    await assert.rejects(
      execute(['sandbox', 'exec'], { stage: 'seed', timeoutMs: 1_000 }),
      (error) => {
        assert.equal(error.message, 'Railway seed failed (exit 75); remote output suppressed');
        assert.doesNotMatch(error.message, new RegExp(secretCode));
        return true;
      },
    );
  });

  it('captures only bounded sandbox-create JSON', async () => {
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.kill = () => {
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        return true;
      };
      queueMicrotask(() => {
        child.stdout.emit('data', JSON.stringify({ id: 'sandbox-captured' }));
        child.emit('close', 0, null);
      });
      return child;
    };
    const execute = createRailwayExecutor(spawnImpl);
    assert.equal(
      await execute(['sandbox', 'create'], { stage: 'create', timeoutMs: 1_000 }),
      JSON.stringify({ id: 'sandbox-captured' }),
    );

    const overflow = createRailwayExecutor(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.kill = () => {
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        return true;
      };
      queueMicrotask(() => child.stdout.emit('data', 'x'.repeat(1024 * 1024 + 1)));
      return child;
    });
    await assert.rejects(
      overflow(['sandbox', 'create'], { stage: 'create', timeoutMs: 1_000 }),
      /create response exceeded the output limit; remote output suppressed/,
    );
  });

  it('terminates and classifies a Railway command that reaches its deadline', async () => {
    const signals = [];
    // The executor deliberately unrefs its timers. Keep this test's event loop
    // alive until the fake child reports the deadline-triggered close.
    const keepAlive = setTimeout(() => {}, 1_000);
    const execute = createRailwayExecutor(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.kill = (signal) => {
        signals.push(signal);
        queueMicrotask(() => child.emit('close', null, signal));
        return true;
      };
      return child;
    });

    try {
      await assert.rejects(
        execute(['sandbox', 'exec'], { stage: 'seed', timeoutMs: 5 }),
        /Railway seed timed out; remote output suppressed/,
      );
      assert.deepEqual(signals, ['SIGTERM']);
    } finally {
      clearTimeout(keepAlive);
    }
  });

  it('terminates the active sandbox seeder before shell cleanup', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cross-strait-seed-signal-'));
    const workspaceMarker = join(tempDir, 'workspace');
    const seedReadyMarker = join(tempDir, 'seed-ready');
    const seedPidMarker = join(tempDir, 'seed-pid');
    const postflightMarker = join(tempDir, 'postflight');
    const writeExecutable = (name, source) => {
      const path = join(tempDir, name);
      writeFileSync(path, `#!/bin/sh\n${source}\n`);
      chmodSync(path, 0o755);
    };
    writeExecutable('git', `
if [ "$1" = "init" ]; then printf '%s' "$3" > ${JSON.stringify(workspaceMarker)}; fi
if [ "$1" = "-C" ] && [ "$3" = "checkout" ]; then mkdir -p "$2/scripts"; fi
if [ "$3" = "rev-parse" ]; then printf '%s\\n' "$WM_ONE_OFF_DEPLOYED_COMMIT"; fi
exit 0`);
    writeExecutable('npm', 'exit 0');
    writeExecutable('node', `
if [ "$1" = "--eval" ] && [ "$#" -eq 5 ]; then
  exec ${JSON.stringify(process.execPath)} "$@"
fi
if [ "$1" = "seed-cross-strait-activity.mjs" ]; then
  printf '%s' "$$" > ${JSON.stringify(seedPidMarker)}
  printf 'ready' > ${JSON.stringify(seedReadyMarker)}
  trap '' TERM
  while :; do sleep 1; done
fi
printf 'postflight' > ${JSON.stringify(postflightMarker)}
exit 0`);

    try {
      const child = spawn('/bin/sh', ['-c', SANDBOX_SEED_PROGRAM], {
        env: {
          ...process.env,
          PATH: `${tempDir}:${process.env.PATH}`,
          WM_ONE_OFF_DEPLOYED_COMMIT: DEPLOYED_COMMIT,
        },
        stdio: 'ignore',
      });
      const deadline = Date.now() + 15_000;
      while (!existsSync(seedReadyMarker) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(existsSync(seedReadyMarker), true);
      child.kill('SIGTERM');
      const signalStartedAt = Date.now();
      const [code] = await once(child, 'close');

      assert.equal(code, 143);
      assert.ok(Date.now() - signalStartedAt < 12_000);
      const seedPid = Number(readFileSync(seedPidMarker, 'utf8'));
      assert.throws(
        () => process.kill(seedPid, 0),
        (error) => error?.code === 'ESRCH',
      );
      assert.equal(existsSync(postflightMarker), false);
      assert.equal(existsSync(readFileSync(workspaceMarker, 'utf8')), false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('handles a real termination signal and attempts explicit cleanup', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cross-strait-signal-'));
    const fakeRailway = join(tempDir, 'railway');
    const cleanupMarker = join(tempDir, 'destroyed');
    writeFileSync(fakeRailway, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'sandbox' && args[1] === 'create') {
  console.log(JSON.stringify({ id: 'sandbox-real-signal' }));
} else if (args[0] === 'sandbox' && args[1] === 'destroy') {
  fs.writeFileSync(${JSON.stringify(cleanupMarker)}, 'destroyed');
} else {
  process.on('SIGTERM', () => process.exit(143));
  setInterval(() => {}, 1000);
}
`);
    chmodSync(fakeRailway, 0o755);

    try {
      const child = spawn(process.execPath, [
        new URL('../scripts/run-cross-strait-history-one-off.mjs', import.meta.url).pathname,
        '--project', 'project-1',
        '--environment', 'production',
        '--confirm-production',
      ], {
        env: { ...process.env, PATH: `${tempDir}:${process.env.PATH}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.setEncoding('utf8');
      let stdout = '';
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('runner did not reach preflight')), 5_000);
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
          if (stdout.includes('validating configuration')) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      child.kill('SIGTERM');
      const [code] = await once(child, 'close');

      assert.equal(code, 1);
      assert.equal(existsSync(cleanupMarker), true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('registers one explicit operator command instead of an arbitrary remote runner', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(
      packageJson.scripts['railway:cross-strait-history:force'],
      'node scripts/run-cross-strait-history-one-off.mjs',
    );
  });

  it('requires an explicit production confirmation before invoking Railway', () => {
    const result = runCli([
      '--project', 'project-1',
      '--environment', 'production',
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--confirm-production is required/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /creating bounded Railway sandbox/);
  });

  it('rejects incomplete and unknown CLI arguments before invoking Railway', () => {
    for (const args of [
      ['--project'],
      ['--project', 'project-1', '--environment', 'production', '--unknown'],
    ]) {
      const result = runCli(args);
      assert.equal(result.status, 1);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /creating bounded Railway sandbox/);
    }
  });
});
