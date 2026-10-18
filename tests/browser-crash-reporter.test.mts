import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { FullResult, TestResult } from '@playwright/test/reporter';

import BrowserCrashReporter, {
  BrowserExitTally,
  captureNotices,
  crashSampleLines,
  crashSummaryLine,
  tallyBrowserProcessExits,
} from '../e2e/browser-crash-reporter';

// Shapes copied verbatim from the pw:browser producer, as pinned by the fixture
// in tests/ci-workflow-coverage.test.mts. A parser that only recognises one of
// these two is how a crash count silently reads zero.
const SIGTRAP = 'pw:browser [pid=101] <process did exit: exitCode=null, signal=SIGTRAP>';
const CLEAN_EXIT = 'pw:browser [pid=102] <process did exit: exitCode=0, signal=null>';
const SIGKILL = 'pw:browser [pid=103] <process did exit: exitCode=null, signal=SIGKILL>';

describe('browser crash accounting (#8447)', () => {
  it('counts a signal exit as a crash, not a clean shutdown', () => {
    const tally = tallyBrowserProcessExits(`${SIGTRAP}\n`);

    assert.equal(tally.crashes.length, 1);
    assert.equal(tally.crashes[0]!.signal, 'SIGTRAP');
    assert.equal(tally.cleanExits, 0);
  });

  it('treats exitCode=0, signal=null as an orderly close', () => {
    const tally = tallyBrowserProcessExits(`${CLEAN_EXIT}\n`);

    assert.deepEqual(tally.crashes, []);
    assert.equal(tally.cleanExits, 1);
  });

  it('separates crashes from clean exits in one stream', () => {
    const tally = tallyBrowserProcessExits(
      `${CLEAN_EXIT}\n${SIGTRAP}\nunrelated log line\n${CLEAN_EXIT}\n${SIGKILL}\n`,
    );

    assert.equal(tally.crashes.length, 2);
    assert.equal(tally.cleanExits, 2);
    assert.deepEqual(
      tally.crashes.map((crash) => crash.signal),
      ['SIGTRAP', 'SIGKILL'],
    );
  });

  it('counts a non-zero exit with no signal as a crash', () => {
    // An OOM kill reports a code, not a signal. Reading it as a clean exit
    // would reintroduce the swallow this reporter exists to prevent.
    const tally = tallyBrowserProcessExits(
      'pw:browser [pid=104] <process did exit: exitCode=137, signal=null>\n',
    );

    assert.equal(tally.crashes.length, 1);
    assert.equal(tally.cleanExits, 0);
  });

  it('records an exit shape it cannot parse instead of dropping it', () => {
    const tally = tallyBrowserProcessExits(
      'pw:browser [pid=105] <process did exit: code=1>\n',
    );

    assert.deepEqual(tally.crashes, []);
    assert.equal(tally.unparsed.length, 1);
  });

  it('keeps the verbatim log line so the report stays citable', () => {
    const tally = tallyBrowserProcessExits(`noise ${SIGTRAP} noise\n`);

    assert.equal(tally.crashes[0]!.raw, `noise ${SIGTRAP} noise`);
  });

  it('strips debug colour escapes out of the recorded line', () => {
    // DEBUG_COLORS=0 is set only on the ci-smoke job, so every other job feeds
    // coloured output through here. Control characters in the step summary and
    // the JSON artifact are unreadable and ungreppable.
    const coloured = `\u001B[30;1mpw:browser \u001B[0m[pid=106] <process did exit: exitCode=null, signal=SIGTRAP> \u001B[30m+4ms\u001B[0m`;
    const tally = tallyBrowserProcessExits(`${coloured}\n`);

    assert.equal(tally.crashes.length, 1);
    assert.equal(
      tally.crashes[0]!.raw,
      'pw:browser [pid=106] <process did exit: exitCode=null, signal=SIGTRAP> +4ms',
    );
    assert.doesNotMatch(tally.crashes[0]!.raw, /\u001B/);
  });

  it('states zero crashes explicitly rather than printing nothing', () => {
    // A summary that only appears on crashes cannot be told apart from a run
    // whose capture broke, which is the failure mode #8447 is about.
    const line = crashSummaryLine({ crashes: [], cleanExits: 3, unparsed: [], browserLaunches: 3 });

    assert.match(line, /^\[crash-report\] 0 browser crash\(es\)/);
  });

  it('groups the total by cause', () => {
    const tally = tallyBrowserProcessExits(`${SIGTRAP}\n${SIGTRAP}\n${SIGKILL}\n`);

    assert.equal(
      crashSummaryLine(tally),
      '[crash-report] 3 browser crash(es): SIGTRAPx2, SIGKILLx1',
    );
  });

  it('names the cut when the sample list is truncated', () => {
    // GITHUB_STEP_SUMMARY caps at 1 MiB and drops an oversized write whole, so
    // the list is bounded -- but a silent cut reads as if it were complete.
    const tally = tallyBrowserProcessExits(`${SIGTRAP}\n`.repeat(63));
    const { lines, omitted } = crashSampleLines(tally);

    assert.equal(lines.length, 50);
    assert.equal(omitted, 13);
  });

  it('returns every line and no cut when the list fits', () => {
    const { lines, omitted } = crashSampleLines(tallyBrowserProcessExits(`${SIGTRAP}\n${SIGTRAP}\n`));

    assert.equal(lines.length, 2);
    assert.equal(omitted, 0);
  });
});

// The pure-function suite above cannot see the class at all, and the class is
// where the state lives: `enabled` is frozen at construction, the constructor
// rewrites DEBUG, and `absorb` carries a partial line between calls -- but only
// for a chunk the runner attributed to a worker, which is what the two
// unattributed cases below pin down.
describe('browser crash reporter class (#8447)', () => {
  /** The artifact `onEnd` writes only when GITHUB_STEP_SUMMARY is set. */
  const ARTIFACT = 'test-results/browser-crash-report.json';

  /**
   * `enabled` is read once at construction and the constructor mutates DEBUG,
   * so every test snapshots every variable it can touch and restores them
   * in `finally` -- otherwise the DEBUG rewrite leaks into every later suite.
   * GITHUB_STEP_SUMMARY is cleared, not just saved: with it set, `onEnd` writes
   * `test-results/` artifacts as a side effect of being tested.
   *
   * The artifact check is relative to the state before `run()`, not absolute.
   * Any earlier CI job or local run in this checkout can leave
   * `test-results/browser-crash-report.json` behind, and asserting the file is
   * simply absent would then fail on a file this reporter never wrote. What the
   * tests are about is whether *these* runs created or modified it, so the
   * before/after `mtimeMs` is what gets compared.
   */
  const withReporterEnv = async (run: () => Promise<void>): Promise<void> => {
    const saved = {
      DEBUG: process.env.DEBUG,
      WM_CRASH_REPORT: process.env.WM_CRASH_REPORT,
      CI: process.env.CI,
      GITHUB_STEP_SUMMARY: process.env.GITHUB_STEP_SUMMARY,
      DEBUG_FILE: process.env.DEBUG_FILE,
      PW_RUNNER_DEBUG: process.env.PW_RUNNER_DEBUG,
      WM_CRASH_REPORT_LABEL: process.env.WM_CRASH_REPORT_LABEL,
    };
    const restore = (key: keyof typeof saved): void => {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };

    process.env.WM_CRASH_REPORT = '1';
    delete process.env.GITHUB_STEP_SUMMARY;
    delete process.env.DEBUG_FILE;
    delete process.env.PW_RUNNER_DEBUG;
    delete process.env.WM_CRASH_REPORT_LABEL;

    const existedBefore = existsSync(ARTIFACT);
    const mtimeBefore = existedBefore ? statSync(ARTIFACT).mtimeMs : undefined;

    try {
      await run();
      if (!existedBefore) {
        assert.equal(
          existsSync(ARTIFACT),
          false,
          'the reporter under test created an artifact although GITHUB_STEP_SUMMARY was unset',
        );
      } else {
        assert.equal(
          statSync(ARTIFACT).mtimeMs,
          mtimeBefore,
          'the reporter under test modified the artifact although GITHUB_STEP_SUMMARY was unset',
        );
      }
    } finally {
      for (const key of Object.keys(saved) as (keyof typeof saved)[]) restore(key);
    }
  };

  /** `FullResult` needs all three fields; `status` alone does not type-check. */
  const passedResult = (): FullResult => ({
    status: 'passed',
    startTime: new Date(0),
    duration: 0,
  });

  /**
   * `TestResult` is a 20-field interface and only `workerIndex` is read here,
   * so the rest is cast away rather than stubbed out.
   */
  const worker = (workerIndex: number): TestResult => ({ workerIndex }) as unknown as TestResult;

  /** Capture `console.log` by swapping it out; restored by the caller. */
  const captureLog = (): { logged: string[]; restore: () => void } => {
    const logged: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logged.push(args.join(' '));
    };
    return { logged, restore: () => { console.log = original; } };
  };

  it('counts a crash record split across two chunks within one worker', async () => {
    // The record most likely to be cut in half is the one that matters, so the
    // trailing partial line has to survive until the next chunk arrives. A
    // class that parsed each chunk independently would report zero here. The
    // worker identity is what makes the join safe, which is why Playwright
    // supplies it: see the unattributed case below for what happens without it.
    await withReporterEnv(async () => {
      const { logged, restore } = captureLog();
      try {
        const reporter = new BrowserCrashReporter();
        reporter.onStdErr('pw:browser [pid=101] <process did exit: exitCode=null, sig', undefined, worker(0));
        reporter.onStdErr('nal=SIGTRAP>\n', undefined, worker(0));
        await reporter.onEnd(passedResult());

        const summary = logged.find((line) => line.includes('browser crash(es)'));
        assert.ok(summary, `no crash summary printed; got:\n${logged.join('\n')}`);
        assert.match(summary, /^\[crash-report\] 1 browser crash\(es\): SIGTRAPx1$/);
        assert.match(
          logged.find((line) => line.includes('clean browser exits')) ?? '',
          /clean browser exits: 0/,
        );
      } finally {
        restore();
      }
    });
  });

  it('prints the zero-crash summary when no browser died', async () => {
    await withReporterEnv(async () => {
      const { logged, restore } = captureLog();
      try {
        const reporter = new BrowserCrashReporter();
        reporter.onStdOut(`${CLEAN_EXIT}\n`);
        await reporter.onEnd(passedResult());

        const summary = logged.find((line) => line.includes('browser crash(es)'));
        assert.ok(summary, `no crash summary printed; got:\n${logged.join('\n')}`);
        assert.match(summary, /^\[crash-report\] 0 browser crash\(es\)/);
      } finally {
        restore();
      }
    });
  });

  it('keeps one partial-line buffer per worker so interleaved chunks cannot merge', async () => {
    // The runner multiplexes every worker into these two callbacks, so worker 1
    // can deliver a whole line between worker 0's two halves. With one shared
    // buffer the merged line matches only worker 1's clean exit, and worker 0's
    // SIGTRAP is lost without even reaching `unparsed` -- the silent
    // under-report this reporter exists to prevent.
    await withReporterEnv(async () => {
      const { logged, restore } = captureLog();
      try {
        const reporter = new BrowserCrashReporter();
        reporter.onStdErr('pw:browser [pid=101] <process did exit: exitCode=null, sig', undefined, worker(0));
        reporter.onStdErr(`${CLEAN_EXIT}\n`, undefined, worker(1));
        reporter.onStdErr('nal=SIGTRAP>\n', undefined, worker(0));
        await reporter.onEnd(passedResult());

        const summary = logged.find((line) => line.includes('browser crash(es)'));
        assert.ok(summary, `no crash summary printed; got:\n${logged.join('\n')}`);
        assert.match(summary, /^\[crash-report\] 1 browser crash\(es\): SIGTRAPx1$/);
        assert.match(
          logged.find((line) => line.includes('clean browser exits')) ?? '',
          /clean browser exits: 1/,
        );
      } finally {
        restore();
      }
    });
  });

  it('never joins unattributed chunks, so one worker cannot swallow another record', async () => {
    // Teardown output -- a worker-scoped browser closing after its test -- and
    // output from a worker that already failed both reach these callbacks with
    // no `result`, hence no workerIndex to key a buffer on. Two workers then
    // share one key, which is the aliasing the per-worker buffers exist to
    // avoid: worker A's fragment prepended to worker B's clean exit matches only
    // B's record, so A's SIGTRAP is counted nowhere -- not even as unparsed.
    await withReporterEnv(async () => {
      const { logged, restore } = captureLog();
      try {
        const reporter = new BrowserCrashReporter();
        reporter.onStdErr('pw:browser [pid=101] <process did exit: exitCode=null, sig');
        reporter.onStdErr(`${CLEAN_EXIT}\n`);
        reporter.onStdErr('nal=SIGTRAP>\n');
        await reporter.onEnd(passedResult());

        const summary = logged.find((line) => line.includes('browser crash(es)'));
        assert.ok(summary, `no crash summary printed; got:\n${logged.join('\n')}`);
        // Worker B's record survives intact: the fragment is not prepended to it.
        assert.match(summary, /^\[crash-report\] 0 browser crash\(es\)/);
        assert.match(
          logged.find((line) => line.includes('clean browser exits')) ?? '',
          /clean browser exits: 1/,
        );
        // A's fragment carries no identity, so it cannot be counted as a crash
        // and is surfaced instead. The notice is the run's only warning that the
        // count above may be short, which is why it must not be swallowed too.
        assert.match(
          logged.find((line) => line.includes('unrecognised shape')) ?? '',
          /^\[crash-report\] 1 process-exit line\(s\) in an unrecognised shape/,
        );
      } finally {
        restore();
      }
    });
  });

  it('surfaces an unattributed record split inside the exit phrase', async () => {
    // Unattributed output is merged chunk by chunk and never rejoined, so a
    // boundary inside `process did exit` leaves neither half holding the whole
    // phrase. Without the `exitCode=` half of the filter both halves are
    // skipped in silence: no crash counted, no unparsed line, no under-report
    // notice -- the silent gap the merge rule exists to trade away.
    await withReporterEnv(async () => {
      const { logged, restore } = captureLog();
      try {
        const reporter = new BrowserCrashReporter();
        reporter.onStdErr('pw:browser [pid=101] <process di');
        reporter.onStdErr('d exit: exitCode=null, signal=SIGTRAP>\n');
        await reporter.onEnd(passedResult());

        const summary = logged.find((line) => line.includes('browser crash(es)'));
        assert.ok(summary, `no crash summary printed; got:\n${logged.join('\n')}`);
        assert.match(summary, /^\[crash-report\] 0 browser crash\(es\)/);
        assert.match(
          logged.find((line) => line.includes('unrecognised shape')) ?? '',
          /^\[crash-report\] 1 process-exit line\(s\) in an unrecognised shape/,
        );
      } finally {
        restore();
      }
    });
  });

  it('still counts that same split when the worker identity is known', async () => {
    // The join is what covers a phrase split, and it is only available for
    // attributed output. This is the other side of the trade above: with a
    // worker to key on, the two halves are rejoined and the crash is counted.
    await withReporterEnv(async () => {
      const { logged, restore } = captureLog();
      try {
        const reporter = new BrowserCrashReporter();
        reporter.onStdErr('pw:browser [pid=101] <process di', undefined, worker(0));
        reporter.onStdErr('d exit: exitCode=null, signal=SIGTRAP>\n', undefined, worker(0));
        await reporter.onEnd(passedResult());

        const summary = logged.find((line) => line.includes('browser crash(es)'));
        assert.ok(summary, `no crash summary printed; got:\n${logged.join('\n')}`);
        assert.match(summary, /^\[crash-report\] 1 browser crash\(es\): SIGTRAPx1$/);
        assert.equal(
          logged.some((line) => line.includes('unrecognised shape')),
          false,
          'a rejoined record must not be reported as unparsed',
        );
      } finally {
        restore();
      }
    });
  });

  it('separates the stdout and stderr buffers for one worker', async () => {
    // Same hazard between the two streams: a partial stdout line must not be
    // prepended to a stderr record, or the record it swallowed goes uncounted.
    await withReporterEnv(async () => {
      const { logged, restore } = captureLog();
      try {
        const reporter = new BrowserCrashReporter();
        reporter.onStdOut('pw:browser [pid=107] <process did exit: exitCode=null, sig', undefined, worker(0));
        reporter.onStdErr(`${SIGKILL}\n`, undefined, worker(0));
        reporter.onStdOut('nal=SIGTRAP>\n', undefined, worker(0));
        await reporter.onEnd(passedResult());

        const summary = logged.find((line) => line.includes('browser crash(es)'));
        assert.ok(summary, `no crash summary printed; got:\n${logged.join('\n')}`);
        assert.match(summary, /^\[crash-report\] 2 browser crash\(es\): SIGKILLx1, SIGTRAPx1$/);
        assert.match(
          logged.find((line) => line.includes('clean browser exits')) ?? '',
          /clean browser exits: 0/,
        );
      } finally {
        restore();
      }
    });
  });

  it('flushes every worker buffer at the end of the run', async () => {
    // A worker that never emits a trailing newline still holds a complete
    // record, and it is not necessarily the only buffer with content.
    await withReporterEnv(async () => {
      const { logged, restore } = captureLog();
      try {
        const reporter = new BrowserCrashReporter();
        reporter.onStdErr('pw:browser [pid=108] <process did exit: exitCode=null, signal=SIGTRAP>', undefined, worker(2));
        reporter.onStdErr('pw:browser [pid=109] <process did exit: exitCode=137, signal=null>', undefined, worker(3));
        await reporter.onEnd(passedResult());

        const summary = logged.find((line) => line.includes('browser crash(es)'));
        assert.ok(summary, `no crash summary printed; got:\n${logged.join('\n')}`);
        assert.match(summary, /^\[crash-report\] 2 browser crash\(es\): SIGTRAPx1, exitCode=137x1$/);
      } finally {
        restore();
      }
    });
  });

  /** Capture `console.error` the same way `captureLog` captures `console.log`. */
  const captureError = (): { errors: string[]; restore: () => void } => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
    return { errors, restore: () => { console.error = original; } };
  };

  it('does nothing at all when neither CI nor WM_CRASH_REPORT is set', async () => {
    await withReporterEnv(async () => {
      delete process.env.WM_CRASH_REPORT;
      delete process.env.CI;
      delete process.env.DEBUG;
      const { logged, restore } = captureLog();
      try {
        const reporter = new BrowserCrashReporter();
        reporter.onStdErr(`${SIGTRAP}\n`, undefined, worker(0));
        await reporter.onEnd(passedResult());

        assert.deepEqual(logged, []);
        assert.equal(process.env.DEBUG, undefined, 'a disabled reporter must not request pw:browser');
      } finally {
        restore();
      }
    });
  });

  it('adds pw:browser to DEBUG without dropping or duplicating a channel', async () => {
    const cases: [string | undefined, string][] = [
      [undefined, 'pw:browser'],
      ['pw:api', 'pw:api,pw:browser'],
      ['pw:api, pw:browser', 'pw:api, pw:browser'],
    ];
    for (const [before, after] of cases) {
      await withReporterEnv(async () => {
        if (before === undefined) delete process.env.DEBUG;
        else process.env.DEBUG = before;
        new BrowserCrashReporter();
        assert.equal(process.env.DEBUG, after, `DEBUG=${String(before)}`);
      });
    }
  });

  it('warns at construction when worker debug output is diverted away from reporters', async () => {
    await withReporterEnv(async () => {
      process.env.DEBUG_FILE = '/tmp/pw-debug.log';
      const { logged, restore } = captureLog();
      try {
        new BrowserCrashReporter();
        assert.ok(
          logged.some((line) => line.includes('DEBUG_FILE is set')),
          `no diversion warning; got:\n${logged.join('\n')}`,
        );
      } finally {
        restore();
      }
    });
  });

  it('contains an error thrown inside a hook so it cannot fail the run', async () => {
    // Playwright turns any reporter throw into a failed run. A chunk whose
    // `toString` throws stands in for any bug in the parsing path.
    await withReporterEnv(async () => {
      const { restore: restoreLog } = captureLog();
      const { errors, restore: restoreError } = captureError();
      try {
        const reporter = new BrowserCrashReporter();
        const poisoned = { toString: () => { throw new Error('boom'); } } as unknown as Buffer;
        assert.doesNotThrow(() => reporter.onStdErr(poisoned, undefined, worker(0)));
        assert.ok(errors.some((line) => line.includes('boom')), 'the contained error was not reported');
      } finally {
        restoreError();
        restoreLog();
      }
    });
  });

  it('contains an error thrown while reporting at the end of the run', async () => {
    await withReporterEnv(async () => {
      const original = console.log;
      console.log = () => { throw new Error('stdout closed'); };
      const { errors, restore: restoreError } = captureError();
      try {
        const reporter = new BrowserCrashReporter();
        await assert.doesNotReject(reporter.onEnd(passedResult()));
        assert.ok(errors.some((line) => line.includes('stdout closed')), 'the contained error was not reported');
      } finally {
        restoreError();
        console.log = original;
      }
    });
  });

  it('ignores the video recorder ffmpeg that a retried test launches', async () => {
    // `video: 'on-first-retry'` starts ffmpeg through the same launchProcess and
    // the same pw:browser channel. Its exit is not a browser exit, and its
    // `ffmpeg onkill exitCode=...` line must not read as an unparsed record.
    await withReporterEnv(async () => {
      const { logged, restore } = captureLog();
      try {
        const reporter = new BrowserCrashReporter();
        for (const line of [
          'pw:browser <launching> /ms-playwright/chromium_headless_shell-1243/chrome-linux/headless_shell --headless',
          'pw:browser <launched> pid=300',
          'pw:browser <launching> /ms-playwright/ffmpeg-1011/ffmpeg-linux -loglevel error -f matroska',
          'pw:browser <launched> pid=301',
          'pw:browser [pid=301] <process did exit: exitCode=null, signal=SIGKILL>',
          'pw:browser ffmpeg onkill exitCode=null signal=SIGKILL',
          'pw:browser [pid=300] <process did exit: exitCode=0, signal=null>',
        ]) {
          reporter.onStdErr(`${line}\n`, undefined, worker(0));
        }
        await reporter.onEnd(passedResult());

        assert.match(logged.find((line) => line.includes('browser crash(es)')) ?? '', /^\[crash-report\] 0 browser crash\(es\)/);
        assert.match(
          logged.find((line) => line.includes('clean browser exits')) ?? '',
          /browser launches: 1; clean browser exits: 1;/,
        );
        assert.equal(
          logged.some((line) => line.includes('unrecognised shape') || line.includes('no recorded exit')),
          false,
          `ffmpeg leaked into the notices:\n${logged.join('\n')}`,
        );
      } finally {
        restore();
      }
    });
  });

  it('writes a labelled step summary and the JSON artifact when GITHUB_STEP_SUMMARY is set', async () => {
    await withReporterEnv(async () => {
      const dir = mkdtempSync(join(tmpdir(), 'crash-report-'));
      const cwd = process.cwd();
      process.env.GITHUB_STEP_SUMMARY = join(dir, 'summary.md');
      process.env.WM_CRASH_REPORT_LABEL = 'ci-smoke shard 1';
      const { restore } = captureLog();
      process.chdir(dir);
      try {
        const reporter = new BrowserCrashReporter();
        reporter.onStdErr(`pw:browser <launched> pid=101\n${SIGTRAP}\npw:browser [pid=110] <process did exit: code=1>\n`, undefined, worker(0));
        await reporter.onEnd(passedResult());

        const summary = readFileSync(join(dir, 'summary.md'), 'utf8');
        assert.match(summary, /### Browser crashes \(all abnormal exits\), ci-smoke shard 1/);
        assert.match(summary, /1 browser crash\(es\): SIGTRAPx1/);
        assert.ok(summary.includes(SIGTRAP), 'the crash sample line is missing');
        assert.ok(summary.includes('<process did exit: code=1>'), 'the unparsed sample line is missing');

        const artifact = JSON.parse(readFileSync(join(dir, 'test-results/browser-crash-report.json'), 'utf8'));
        assert.equal(artifact.crashes.length, 1);
        assert.equal(artifact.unparsed.length, 1);
        assert.equal(artifact.browserLaunches, 1);
        assert.equal(artifact.runStatus, 'passed');
      } finally {
        process.chdir(cwd);
        restore();
        delete process.env.GITHUB_STEP_SUMMARY;
      }
    });
  });

  it('names a failed step-summary write instead of swallowing it', async () => {
    await withReporterEnv(async () => {
      const dir = mkdtempSync(join(tmpdir(), 'crash-report-'));
      const cwd = process.cwd();
      process.env.GITHUB_STEP_SUMMARY = join(dir, 'missing-dir', 'summary.md');
      const { restore } = captureLog();
      const { errors, restore: restoreError } = captureError();
      process.chdir(dir);
      try {
        await new BrowserCrashReporter().onEnd(passedResult());
        assert.ok(
          errors.some((line) => line.includes('could not write the step summary')),
          `no write failure reported; got:\n${errors.join('\n')}`,
        );
      } finally {
        process.chdir(cwd);
        restoreError();
        restore();
        delete process.env.GITHUB_STEP_SUMMARY;
      }
    });
  });
});

describe('browser exit bookkeeping (#8447 review)', () => {
  it('drops ffmpeg exits even when another worker writes between its launch lines', () => {
    const tally = new BrowserExitTally();
    tally.feed('pw:browser <launching> /ms-playwright/ffmpeg-1011/ffmpeg-linux -f matroska', '0:stderr');
    tally.feed('pw:browser <launching> /ms-playwright/chromium_headless_shell-1243/chrome-linux/headless_shell', '1:stderr');
    tally.feed('pw:browser <launched> pid=401', '1:stderr');
    tally.feed('pw:browser <launched> pid=400', '0:stderr');
    tally.feed('pw:browser [pid=400] <process did exit: exitCode=0, signal=null>', '0:stderr');
    tally.feed('pw:browser [pid=401] <process did exit: exitCode=null, signal=SIGTRAP>', '1:stderr');

    const snapshot = tally.snapshot();
    assert.equal(snapshot.browserLaunches, 1);
    assert.equal(snapshot.cleanExits, 0);
    assert.deepEqual(snapshot.crashes.map((crash) => crash.signal), ['SIGTRAP']);
  });

  it('counts every exit record on a line that carries two', () => {
    const tally = tallyBrowserProcessExits(`${SIGTRAP} ${CLEAN_EXIT}\n`);

    assert.equal(tally.crashes.length, 1);
    assert.equal(tally.cleanExits, 1);
    assert.deepEqual(tally.unparsed, []);
  });

  it('says a zero proves nothing when no browser launch was seen', () => {
    const notices = captureNotices(tallyBrowserProcessExits('unrelated output\n'));

    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /no browser launch was recorded/);
  });

  it('names browsers that launched but never recorded an exit', () => {
    const notices = captureNotices(
      tallyBrowserProcessExits(`pw:browser <launched> pid=1\npw:browser <launched> pid=2\n${CLEAN_EXIT}\n`),
    );

    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /^1 launched browser\(s\) have no recorded exit/);
  });

  it('raises no notice when every launched browser has an exit', () => {
    const notices = captureNotices(tallyBrowserProcessExits(`pw:browser <launched> pid=1\n${SIGTRAP}\n`));

    assert.deepEqual(notices, []);
  });
});
