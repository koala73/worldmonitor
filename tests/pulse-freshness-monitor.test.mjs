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
} from '../scripts/check-pulse-freshness.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function snapshot(ageDays, filename = 'crawlable-live-pulse-2026-09-09.json') {
  return { filename, capturedAt: '2026-09-09', ageDays };
}

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

  it('writes nothing when the pulse is healthy', () => {
    let posted = false;
    const verdict = evaluatePulseFreshness(snapshot(1), { conclusion: 'success' });
    const result = publishPulseFreshness(verdict, {
      repository: 'koala73/worldmonitor',
      gh: () => { throw new Error('must not query issues when healthy'); },
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
