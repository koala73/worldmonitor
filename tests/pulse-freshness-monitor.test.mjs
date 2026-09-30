// The weekly crawlable-pulse refresh failed four consecutive runs with nobody
// told, and the snapshot reached the build ceiling (#8339). These tests pin the
// alarm that would have caught it, and the threshold contract that keeps the
// alarm meaningful.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MAX_LIVE_PULSE_SNAPSHOT_AGE_DAYS } from '../scripts/build-crawlable-corpus.mjs';
import {
  ISSUE_TITLE,
  PULSE_SNAPSHOT_WARN_AGE_DAYS,
  REFRESH_WORKFLOW,
  evaluatePulseFreshness,
  publishPulseFreshness,
  renderBody,
  readLastRefreshRun,
} from '../scripts/check-pulse-freshness.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('refresh listing corroboration', () => {
  it('does not treat a failed rerun after the snapshot as already repaired', () => {
    const lastRun = readLastRefreshRun({
      repository: 'o/r',
      gh: () => ({ total_count: 1, workflow_runs: [{
        id: 1, run_attempt: 2, status: 'completed', conclusion: 'failure',
        created_at: '2026-09-14T00:00:00Z', updated_at: '2026-09-24T00:00:00Z',
      }] }),
    });
    const verdict = evaluatePulseFreshness(HAND_REFRESHED, lastRun);
    assert.equal(verdict.alert, true);
    assert.equal(verdict.lastRun.superseded, false);
    const repaired = evaluatePulseFreshness({
      ...HAND_REFRESHED, capturedAtMs: Date.parse('2026-09-24T01:00:00Z'),
    }, lastRun);
    assert.equal(repaired.alert, false);
    assert.equal(repaired.lastRun.superseded, true);
  });
  it('still reports a stale snapshot when the workflow listing is unknown', () => {
    const verdict = evaluatePulseFreshness(snapshot(10), { unknown: true });
    const writes = [];
    const result = publishPulseFreshness(verdict, {
      repository: 'o/r', gh: () => [[]], ghPost: (_args, body) => writes.push(body),
    });
    assert.equal(result.alert, true);
    assert.equal(writes.length, 1);
    assert.match(writes[0].body, /UNKNOWN/);
  });
  it('preserves an open issue when the latest run is unknown', () => {
    const verdict = evaluatePulseFreshness(snapshot(1), { unknown: true });
    const result = publishPulseFreshness(verdict, {
      repository: 'o/r',
      gh: () => { throw new Error('unknown must not query issues'); },
      ghPost: () => { throw new Error('unknown must not close an issue'); },
    });
    assert.equal(result.state, 'UNKNOWN');
  });
  const run = (id, conclusion) => ({ id, conclusion, created_at: `2026-09-${id}T00:00:00Z`, status: 'completed' });
  for (const [oldResult, newResult] of [['failure', 'success'], ['success', 'failure']]) {
    it(`rejects stale ${oldResult} in favour of current ${newResult}`, () => {
      const replies = [
        { total_count: 1, workflow_runs: [run(20, oldResult)] },
        { total_count: 2, workflow_runs: [run(24, newResult)] },
        { total_count: 2, workflow_runs: [run(24, newResult)] },
      ];
      assert.equal(readLastRefreshRun({ repository: 'o/r', gh: () => replies.shift() }).conclusion, newResult);
    });
  }
  it('does not interpret contradictory empty listings as never run', () => {
    assert.throws(() => readLastRefreshRun({ repository: 'o/r', gh: () => ({ total_count: 10, workflow_runs: [] }) }), /corroborated/);
  });
});

function snapshot(ageDays, filename = 'crawlable-live-pulse-2026-09-09.json') {
  return { filename, capturedAt: '2026-09-09', ageDays };
}

// The 2026-09-19 hand-made refresh (#8340) that landed five days after the
// 2026-09-14 scheduled failure, exactly the state the monitor's first run
// reported as a finding (#8417).
const HAND_REFRESHED = {
  filename: 'crawlable-live-pulse-2026-09-19.json',
  capturedAt: '2026-09-19',
  capturedAtMs: Date.parse('2026-09-19T05:24:34.912Z'),
  ageDays: 1,
};
const FAILED_BEFORE_REFRESH = {
  conclusion: 'failure',
  createdAt: '2026-09-14T04:50:09Z',
  url: 'https://github.com/koala73/worldmonitor/actions/runs/34807475235',
};

describe('pulse freshness thresholds', () => {
  // The warning line, the refresh cadence and the build ceiling are one
  // contract. Below the cadence the alarm fires every healthy week and gets
  // muted; at or above the ceiling the corpus build has already failed and the
  // alarm is no longer an alarm. Assert all three agree so relaxing one alone
  // cannot silently reopen the #8339 gap.
  it('warns after a healthy cycle but before the build ceiling', () => {
    const workflow = readFileSync(
      resolve(repoRoot, '.github/workflows/crawlable-pulse-refresh.yml'),
      'utf8',
    );
    const cron = workflow.match(/^\s*- cron: '([^']+)'/m)?.[1];
    assert.ok(cron, 'the pulse refresh workflow must declare a cron schedule');
    const [, , dayOfMonth, month, dayOfWeek] = cron.split(/\s+/);
    let cadenceDays;
    if (dayOfMonth === '*' && month === '*' && dayOfWeek !== '*') cadenceDays = 7;
    else if (dayOfMonth !== '*' && month === '*') cadenceDays = 31;
    else if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') cadenceDays = 1;
    else assert.fail(`unrecognised pulse refresh cadence: ${cron}`);

    assert.ok(
      PULSE_SNAPSHOT_WARN_AGE_DAYS > cadenceDays,
      `a ${PULSE_SNAPSHOT_WARN_AGE_DAYS}-day warning under a ${cadenceDays}-day cadence fires on every healthy cycle`,
    );
    assert.ok(
      PULSE_SNAPSHOT_WARN_AGE_DAYS < MAX_LIVE_PULSE_SNAPSHOT_AGE_DAYS,
      'the warning must land before the ceiling that fails the corpus build, or it warns about a broken build',
    );
  });

  it('the monitor runs more often than the thing it watches', () => {
    const monitor = readFileSync(
      resolve(repoRoot, '.github/workflows/pulse-freshness-monitor.yml'),
      'utf8',
    );
    const cron = monitor.match(/^\s*- cron: '([^']+)'/m)?.[1];
    assert.ok(cron, 'the monitor must declare a cron schedule');
    const [, , dayOfMonth, month, dayOfWeek] = cron.split(/\s+/);
    assert.ok(
      dayOfMonth === '*' && month === '*' && dayOfWeek === '*',
      `the monitor must run daily to bound notice to a day; got '${cron}'`,
    );
  });
});

describe('pulse freshness verdict', () => {
  it('stays quiet on a fresh snapshot behind a successful refresh', () => {
    const verdict = evaluatePulseFreshness(snapshot(2), { conclusion: 'success' });
    assert.equal(verdict.alert, false);
    assert.deepEqual(verdict.reasons, []);
  });

  it('reports a failed refresh even while the snapshot is still fresh', () => {
    // The #8339 failure mode exactly: four failures were invisible because the
    // committed snapshot stayed inside the ceiling the whole time.
    const verdict = evaluatePulseFreshness(snapshot(1), { conclusion: 'failure', createdAt: '2026-09-14' });
    assert.equal(verdict.alert, true);
    assert.deepEqual(verdict.reasons.map((r) => r.kind), ['refresh-failed']);
  });

  it('does not report a failed refresh that a newer snapshot has already superseded', () => {
    // A hand refresh merged after the failure is the remedy the issue body asks
    // for. Re-reporting the failure the next morning reopened the same issue a
    // day after it was fixed (#8417).
    const verdict = evaluatePulseFreshness(HAND_REFRESHED, FAILED_BEFORE_REFRESH);
    assert.equal(verdict.alert, false);
    assert.deepEqual(verdict.reasons, []);
    assert.equal(verdict.lastRun.superseded, true);
    assert.match(renderBody(verdict), /Last refresh run: `failure`.*superseded/);
  });

  it('still reports a failed refresh that postdates the newest snapshot by hours', () => {
    // capturedAtMs, not the date-only capturedAt, decides: a dispatch that
    // failed later the same day is the newest signal and must not hide behind
    // the morning's snapshot.
    const laterSameDay = { ...FAILED_BEFORE_REFRESH, createdAt: '2026-09-19T09:00:00Z' };
    const verdict = evaluatePulseFreshness(HAND_REFRESHED, laterSameDay);
    assert.deepEqual(verdict.reasons.map((r) => r.kind), ['refresh-failed']);
    assert.equal(verdict.lastRun.superseded, false);
  });

  it('fails closed on a snapshot without capturedAtMs: only a later day supersedes', () => {
    const dateOnly = { filename: 'crawlable-live-pulse-2026-09-14.json', capturedAt: '2026-09-14', ageDays: 1 };
    assert.deepEqual(
      evaluatePulseFreshness(dateOnly, FAILED_BEFORE_REFRESH).reasons.map((r) => r.kind),
      ['refresh-failed'],
    );
    const nextDay = { ...dateOnly, filename: 'crawlable-live-pulse-2026-09-15.json', capturedAt: '2026-09-15' };
    assert.deepEqual(evaluatePulseFreshness(nextDay, FAILED_BEFORE_REFRESH).reasons, []);
  });

  it('warns once the snapshot passes the warning line', () => {
    const verdict = evaluatePulseFreshness(snapshot(PULSE_SNAPSHOT_WARN_AGE_DAYS + 0.5), { conclusion: 'success' });
    assert.deepEqual(verdict.reasons.map((r) => r.kind), ['stale']);
    assert.match(verdict.reasons[0].detail, /day\(s\) from the 10-day ceiling/);
  });

  it('escalates past the ceiling to say the build is already blocked', () => {
    const verdict = evaluatePulseFreshness(snapshot(MAX_LIVE_PULSE_SNAPSHOT_AGE_DAYS + 1), { conclusion: 'success' });
    assert.deepEqual(verdict.reasons.map((r) => r.kind), ['build-blocked']);
    assert.match(verdict.reasons[0].detail, /deploy is blocked/);
  });

  it('never double-reports the same snapshot as both stale and build-blocked', () => {
    const verdict = evaluatePulseFreshness(snapshot(MAX_LIVE_PULSE_SNAPSHOT_AGE_DAYS + 3), { conclusion: 'success' });
    assert.equal(verdict.reasons.length, 1);
  });

  it('alerts when no snapshot exists at all', () => {
    const verdict = evaluatePulseFreshness(null, { conclusion: 'success' });
    assert.equal(verdict.alert, true);
    assert.deepEqual(verdict.reasons.map((r) => r.kind), ['missing']);
  });

  it('treats an unknown run conclusion as no run signal, not a failure', () => {
    // A queued or in-progress run has conclusion null. Alerting on that would
    // fire against a refresh that is working.
    const verdict = evaluatePulseFreshness(snapshot(1), { conclusion: null });
    assert.equal(verdict.alert, false);
  });

  it('carries both findings when a stale snapshot follows a failed refresh', () => {
    const verdict = evaluatePulseFreshness(
      snapshot(PULSE_SNAPSHOT_WARN_AGE_DAYS + 1),
      { conclusion: 'failure' },
    );
    assert.deepEqual(verdict.reasons.map((r) => r.kind), ['stale', 'refresh-failed']);
  });
});

describe('pulse freshness reporting', () => {
  it('reuses one open issue instead of filing a new one each day', () => {
    const calls = [];
    const verdict = evaluatePulseFreshness(snapshot(9), { conclusion: 'failure' });
    const result = publishPulseFreshness(verdict, {
      repository: 'koala73/worldmonitor',
      gh: () => [[{ number: 8339, title: ISSUE_TITLE }]],
      ghPost: (args, payload) => { calls.push({ args, payload }); return {}; },
    });

    assert.equal(result.action, 'updated');
    assert.ok(calls[0].args.includes('PATCH'), 'an existing issue is updated, never duplicated');
    assert.ok(calls[0].args.some((arg) => arg.endsWith('/issues/8339')));
  });

  it('opens an issue when none is on file', () => {
    const calls = [];
    const verdict = evaluatePulseFreshness(snapshot(9), { conclusion: 'success' });
    const result = publishPulseFreshness(verdict, {
      repository: 'koala73/worldmonitor',
      gh: () => [[{ number: 1, title: 'something else' }]],
      ghPost: (args, payload) => { calls.push({ args, payload }); return {}; },
    });

    assert.equal(result.action, 'created');
    assert.ok(calls[0].args.includes('POST'));
    assert.equal(calls[0].payload.title, ISSUE_TITLE);
  });

  it('skips a pull request that happens to share the issue title', () => {
    const calls = [];
    const verdict = evaluatePulseFreshness(snapshot(9), { conclusion: 'success' });
    publishPulseFreshness(verdict, {
      repository: 'koala73/worldmonitor',
      gh: () => [[{ number: 42, title: ISSUE_TITLE, pull_request: { url: 'x' } }]],
      ghPost: (args, payload) => { calls.push({ args, payload }); return {}; },
    });
    assert.ok(calls[0].args.includes('POST'), 'a PR is not an issue to update');
  });

  it('closes the open issue once the pulse is healthy, with a comment that notifies', () => {
    // An issue left open is updated silently (a body PATCH sends no
    // notification), so the next real finding would reach nobody. Closing on
    // recovery makes the next finding a fresh issue.
    const calls = [];
    const verdict = evaluatePulseFreshness(HAND_REFRESHED, FAILED_BEFORE_REFRESH);
    const result = publishPulseFreshness(verdict, {
      repository: 'koala73/worldmonitor',
      gh: () => [[{ number: 8417, title: ISSUE_TITLE }]],
      ghPost: (args, payload) => { calls.push({ args, payload }); return {}; },
    });

    assert.deepEqual(result, { alert: false, action: 'closed' });
    const [comment, close] = calls;
    assert.ok(comment.args.some((arg) => arg.endsWith('/issues/8417/comments')));
    assert.match(comment.payload.body, /crawlable-live-pulse-2026-09-19\.json/);
    assert.ok(close.args.includes('PATCH'));
    assert.ok(close.args.some((arg) => arg.endsWith('/issues/8417')));
    assert.equal(close.payload.state, 'closed');
    assert.equal(calls.length, 2, 'nothing is created while healthy');
  });

  it('writes nothing when the pulse is healthy and no issue is open', () => {
    let posted = false;
    const verdict = evaluatePulseFreshness(snapshot(1), { conclusion: 'success' });
    const result = publishPulseFreshness(verdict, {
      repository: 'koala73/worldmonitor',
      gh: () => [[{ number: 1, title: 'something else' }]],
      ghPost: () => { posted = true; return {}; },
    });
    assert.deepEqual(result, { alert: false });
    assert.equal(posted, false);
  });

  it('tells the reader how to fix it, including the keyless-freeze trap', () => {
    const body = renderBody(evaluatePulseFreshness(snapshot(9), { conclusion: 'failure' }));
    assert.match(body, new RegExp(REFRESH_WORKFLOW));
    assert.match(body, /teasers:welcome/);
    assert.match(body, /build:llms-full/);
    assert.match(body, /briefCountryCount/);
  });
});
