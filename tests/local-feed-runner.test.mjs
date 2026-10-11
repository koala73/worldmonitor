import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createLocalFeedRunner, LOCAL_FEED_JOBS, localFeedReadiness, parseLocalFeedArgs, selectLocalFeedJobs,
} from '../scripts/local-feed-runner.mjs';

const readyEnv = { UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:8079', UPSTASH_REDIS_REST_TOKEN: 'synthetic-cache-token' };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function harness({ killCloses = false, env = readyEnv, ...options } = {}) {
  let time = 0;
  let nextTimer = 0;
  const timers = new Map();
  const children = [];
  const events = [];
  const signals = [];
  const runner = createLocalFeedRunner({
    jobs: 'military-flights', once: true, ...options, env,
    now: () => time,
    setTimer: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimer: (id) => timers.delete(id),
    logger: (event) => events.push(event),
    spawnProcess: (command, args, config) => {
      const child = new EventEmitter();
      child.pid = 100 + children.length;
      children.push({ child, command, args, config });
      return child;
    },
    killProcess: (child, signal) => {
      signals.push({ child, signal });
      if (killCloses === true || killCloses === signal) child.emit('close', null, signal);
    },
  });
  async function advance(ms) {
    const target = time + ms;
    let iterations = 0;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      assert.ok(++iterations < 100, 'scheduler must not busy-loop');
      const [id, timer] = due;
      timers.delete(id);
      time = timer.at;
      timer.callback();
      await flush();
    }
    time = target;
    await flush();
  }
  return { runner, children, events, signals, timers, advance };
}

describe('local feed selection and prerequisites', () => {
  it('starts nothing without an explicit allowlisted selection', () => {
    for (const value of [undefined, '', 'all', '../seed-insights.mjs', 'aviation,', 'webcams,unknown']) {
      assert.throws(() => selectLocalFeedJobs(value));
    }
    assert.deepEqual(selectLocalFeedJobs('aviation, military-flights,aviation').map((job) => job.id), ['aviation', 'military-flights']);
  });

  it('accepts CLI or environment selections and validates options before spawning', () => {
    assert.deepEqual(parseLocalFeedArgs(['--jobs', 'aviation', '--once'], {}), { jobs: 'aviation', once: true, list: false, help: false });
    assert.equal(parseLocalFeedArgs([], { LOCAL_FEED_JOBS: 'portwatch' }).jobs, 'portwatch');
    assert.equal(parseLocalFeedArgs(['--jobs=webcams'], {}).jobs, 'webcams');
    assert.equal(parseLocalFeedArgs(['--list'], {}).list, true);
    for (const args of [[], ['--jobs'], ['--jobs='], ['--all'], ['--jobs', '--once']]) {
      assert.throws(() => parseLocalFeedArgs(args, {}));
    }
    assert.throws(() => createLocalFeedRunner({ jobs: 'aviation', maxConcurrent: 0 }));
  });

  it('checks shared cache credentials and skips unconfigured Windy without treating public feeds as keyed', () => {
    const webcam = LOCAL_FEED_JOBS.find((job) => job.id === 'webcams');
    assert.equal(localFeedReadiness(webcam, readyEnv).status, 'skipped');
    assert.equal(localFeedReadiness(webcam, { ...readyEnv, WINDY_API_KEY: 'synthetic-windy-key' }).ready, true);
    for (const job of LOCAL_FEED_JOBS.filter((item) => item.id !== 'webcams')) {
      assert.equal(localFeedReadiness(job, readyEnv).ready, true);
      assert.equal(localFeedReadiness(job, {}).status, 'failed');
      assert.equal(localFeedReadiness(job, { ...readyEnv, UPSTASH_REDIS_REST_URL: 'file:///tmp/cache' }).status, 'failed');
    }
  });

  it('--list reports configuration names without running collectors or revealing values', async () => {
    const script = fileURLToPath(new URL('../scripts/local-feed-runner.mjs', import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, [script, '--list'], {
      env: { ...process.env, NODE_TEST_CONTEXT: 'fixture', ...readyEnv, WINDY_API_KEY: 'do-not-print-this-key' },
    });
    const jobs = JSON.parse(stdout);
    assert.deepEqual(jobs.map((job) => job.id), ['aviation', 'military-flights', 'webcams', 'portwatch']);
    assert.doesNotMatch(stdout, /do-not-print-this-key|synthetic-cache-token/);
  });
});

describe('bounded local feed child scheduling', () => {
  it('runs selected collectors independently with bounded concurrency and no forecast chaining', async () => {
    const h = harness({ jobs: 'aviation,military-flights,portwatch' });
    const done = h.runner.start();
    assert.equal(h.children.length, 2);
    assert.equal(h.children[0].command, process.execPath);
    assert.match(h.children[0].args[0], /scripts\/seed-aviation\.mjs$/);
    assert.equal(h.children[0].config.shell, false);
    assert.equal(h.children[1].config.env.CHAIN_FORECAST_SEED_ON_MILITARY, '0');
    h.children[1].child.emit('close', 1, null);
    await flush();
    assert.equal(h.children.length, 3);
    h.children[0].child.emit('close', 0, null);
    h.children[2].child.emit('close', 0, null);
    const results = await done;
    assert.equal(results.find((result) => result.job === 'military-flights').status, 'failed');
    assert.equal(results.filter((result) => result.status === 'completed').length, 2);
    assert.equal(h.timers.size, 0);
  });

  it('skips Windy without its key and rejects missing cache credentials before spawning', async () => {
    for (const [env, status] of [[readyEnv, 'skipped'], [{}, 'failed']]) {
      const h = harness({ jobs: 'webcams', env });
      const results = await h.runner.start();
      assert.equal(h.children.length, 0);
      assert.equal(results[0].status, status);
    }
  });

  it('records a spawn failure and still drains the remaining queue', async () => {
    const h = harness({ jobs: 'aviation,portwatch', maxConcurrent: 1 });
    const done = h.runner.start();
    h.children[0].child.emit('error', new Error('fixture spawn failure'));
    await flush();
    assert.equal(h.children.length, 2);
    h.children[1].child.emit('close', 0, null);
    assert.deepEqual((await done).map((result) => result.status), ['failed', 'completed']);
  });

  it('times out a stuck child, escalates SIGTERM to SIGKILL, and reports the timeout', async () => {
    const h = harness({ killCloses: 'SIGKILL' });
    const done = h.runner.start();
    await h.advance(120_000);
    assert.deepEqual(h.signals.map((entry) => entry.signal), ['SIGTERM']);
    await h.advance(5_000);
    assert.deepEqual(h.signals.map((entry) => entry.signal), ['SIGTERM', 'SIGKILL']);
    assert.equal((await done)[0].status, 'timed-out');
    assert.equal(h.timers.size, 0);
  });

  it('does not overlap a job even when termination outlives the next scheduled start', async () => {
    const h = harness({ once: false });
    h.runner.start();
    await h.advance(360_000);
    assert.equal(h.children.length, 1);
    h.children[0].child.emit('close', null, 'SIGKILL');
    await flush();
    assert.equal(h.children.length, 2);
    const done = h.runner.stop();
    h.children[1].child.emit('close', null, 'SIGTERM');
    await done;
    assert.equal(h.timers.size, 0);
  });

  it('waits for the source cadence after an ordinary child completion', async () => {
    const h = harness({ once: false });
    h.runner.start();
    h.children[0].child.emit('close', 0, null);
    await flush();
    await h.advance(299_999);
    assert.equal(h.children.length, 1);
    await h.advance(1);
    assert.equal(h.children.length, 2);
    const done = h.runner.stop();
    h.children[1].child.emit('close', null, 'SIGTERM');
    await done;
  });

  it('stops all active children, never starts queued jobs, and clears timers', async () => {
    const h = harness({ jobs: 'aviation,military-flights,portwatch', killCloses: true, once: false });
    h.runner.start();
    await h.runner.stop();
    await flush();
    assert.equal(h.children.length, 2);
    assert.deepEqual(h.signals.map((entry) => entry.signal), ['SIGTERM', 'SIGTERM']);
    assert.equal(h.timers.size, 0);
  });

  it('cleans up a real synthetic child process on stop without invoking a feed', async () => {
    let child;
    const runner = createLocalFeedRunner({
      jobs: 'portwatch', env: readyEnv, logger: () => {},
      spawnProcess(command, _args, options) {
        child = spawn(command, ['-e', 'process.on("SIGTERM", () => process.exit(0)); process.send("ready"); setInterval(() => {}, 1000);'], {
          ...options, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        return child;
      },
    });
    runner.start();
    try {
      await once(child, 'message');
      const results = await runner.stop();
      assert.equal(results[0].status, 'stopped');
      assert.equal(child.exitCode, 0);
    } finally {
      await runner.stop();
    }
  });
});
