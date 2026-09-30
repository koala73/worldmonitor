#!/usr/bin/env node
// Alarm for the weekly crawlable-pulse refresh.
//
// .github/workflows/crawlable-pulse-refresh.yml freezes the pulse every Monday
// and opens a review PR. Between 2026-09-02 and 2026-09-14 it ran four times,
// failed four times, and nobody was told (#8339). The committed snapshot went
// ten days stale and reached the MAX_LIVE_PULSE_SNAPSHOT_AGE_DAYS ceiling that
// fails the corpus build, so the first visible symptom would have been a
// blocked deploy.
//
// Nothing was broken about the notifications; that is the platform default.
// GitHub emails a scheduled workflow's failure to exactly one person, the
// account that last edited the `cron:` line, and applies that account's own
// notification settings. There is no team-visible signal to miss.
//
// So this monitor alerts on the SYMPTOM (is the published snapshot fresh?)
// rather than only the cause (did the job exit 0?). The SRE argument for
// preferring symptoms applies with unusual force here: a scheduled workflow
// GitHub has auto-disabled after 60 days of repository inactivity emits no
// failure at all, and this repo is public, so that rule applies. An
// execution-only alarm cannot fire for a job that never ran. A staleness alarm
// still does.
//
// The run-conclusion check is the fast half, not the reliable half: it turns a
// week of silence into a day. Age is what fails closed. A failed run that the
// newest snapshot postdates has already been remedied and is not reported; the
// first run of this monitor reopened a fixed problem that way (#8417).
//
// Findings live in one issue that the monitor closes, with a comment, once the
// pulse is healthy again. Left open, the daily body edit notifies nobody.

import { spawnSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MAX_LIVE_PULSE_SNAPSHOT_AGE_DAYS,
  livePulseSnapshotAgeDays,
} from './build-crawlable-corpus.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { corroborateRunListings, reduceRunListings } from './lib/gh-run-listing.mjs';

export const ISSUE_TITLE = 'Crawlable pulse refresh: snapshot is going stale';
export const SNAPSHOT_DIR = 'docs/snapshots';
export const REFRESH_WORKFLOW = 'crawlable-pulse-refresh.yml';
const SNAPSHOT_RE = /^crawlable-live-pulse-(\d{4}-\d{2}-\d{2})\.json$/;

// Must sit strictly between the refresh cadence and the build ceiling, and the
// band is only two days wide. Below the cadence it would fire on every healthy
// week; at or above the ceiling the corpus build has already failed and the
// alarm is too late to be an alarm. 8 leaves one day of slack for the review PR
// to be merged before the next cron lands. tests/pulse-freshness-monitor.test.mjs
// asserts this against the workflow's own cron so relaxing either alone cannot
// silently reopen the gap.
export const PULSE_SNAPSHOT_WARN_AGE_DAYS = 8;

function ghJson(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr || 'GitHub API call failed');
  }
  return JSON.parse(result.stdout);
}

function ghWrite(args, payload) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
    input: JSON.stringify(payload),
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr || 'GitHub API call failed');
  }
  return JSON.parse(result.stdout);
}

/**
 * Newest committed snapshot and its age. Deliberately NOT
 * resolveLatestLivePulseSnapshotPath: that throws once the snapshot passes the
 * build ceiling, which is precisely the state this monitor exists to report.
 * An alarm that crashes on the condition it watches is not an alarm.
 */
export function readNewestSnapshot(rootDir, now = Date.now()) {
  const dir = join(rootDir, SNAPSHOT_DIR);
  const dated = readdirSync(dir)
    .map((filename) => ({ filename, match: filename.match(SNAPSHOT_RE) }))
    .filter(({ match }) => match)
    .sort((a, b) => b.match[1].localeCompare(a.match[1]));
  if (dated.length === 0) return null;

  const [{ filename, match }] = dated;
  const parsed = JSON.parse(readFileSync(join(dir, filename), 'utf8'));
  const capturedAt = parsed.capturedAt ?? match[1];
  return {
    filename,
    capturedAt,
    capturedAtMs: Number.isFinite(parsed.capturedAtMs) ? parsed.capturedAtMs : null,
    ageDays: livePulseSnapshotAgeDays(capturedAt, now),
  };
}

function capturedInstant({ capturedAtMs, capturedAt }) {
  if (Number.isFinite(capturedAtMs)) return capturedAtMs;
  // Date-only capture reads as midnight UTC, so a run later that day still
  // counts as newer and the alarm fails closed.
  return Date.parse(`${String(capturedAt || '').slice(0, 10)}T00:00:00Z`);
}

/**
 * Pure verdict. Kept separate from every GitHub call so the thresholds are
 * testable without a network.
 *
 * @param {{ filename: string, capturedAt: string, capturedAtMs?: number | null, ageDays: number } | null} snapshot
 * @param {{ conclusion: string | null, url?: string, createdAt?: string, completedAt?: string } | null} lastRun
 */
export function evaluatePulseFreshness(snapshot, lastRun, {
  warnAgeDays = PULSE_SNAPSHOT_WARN_AGE_DAYS,
  ceilingDays = MAX_LIVE_PULSE_SNAPSHOT_AGE_DAYS,
} = {}) {
  const reasons = [];
  if (!snapshot) {
    reasons.push({
      kind: 'missing',
      detail: `No crawlable-live-pulse snapshot found in ${SNAPSHOT_DIR}.`,
    });
    return { alert: true, reasons, snapshot, lastRun };
  }

  const age = Math.floor(snapshot.ageDays);
  if (snapshot.ageDays > ceilingDays) {
    reasons.push({
      kind: 'build-blocked',
      detail: `${snapshot.filename} is ${age} days old, past the ${ceilingDays}-day ceiling. `
        + 'The corpus build is already failing; a deploy is blocked until the pulse is refreshed.',
    });
  } else if (snapshot.ageDays > warnAgeDays) {
    reasons.push({
      kind: 'stale',
      detail: `${snapshot.filename} is ${age} days old, past the ${warnAgeDays}-day warning line `
        + `and ${Math.max(0, Math.ceil(ceilingDays - snapshot.ageDays))} day(s) from the `
        + `${ceilingDays}-day ceiling that fails the corpus build.`,
    });
  }

  // A failed run is reported even while the snapshot is still fresh: that is the
  // whole point of the fast half. Four consecutive failures were invisible
  // because the last committed snapshot was inside the ceiling the whole time.
  // A failure the newest snapshot postdates is not a finding, though: a refresh
  // merged after it is the remedy this issue asks for, and re-reporting the
  // failure reopened the issue a day after the fix (#8417). A run without a
  // timestamp compares as never superseded.
  const failed = Boolean(lastRun?.conclusion) && lastRun.conclusion !== 'success';
  // Reruns retain created_at; only a snapshot after the failed attempt can
  // repair that failure. Older callers without attempt timing use createdAt.
  const superseded = failed && capturedInstant(snapshot) > Date.parse(lastRun.completedAt ?? lastRun.createdAt ?? '');
  if (failed && !superseded) {
    reasons.push({
      kind: 'refresh-failed',
      detail: `The most recent ${REFRESH_WORKFLOW} run concluded \`${lastRun.conclusion}\``
        + `${lastRun.createdAt ? ` (${lastRun.createdAt})` : ''}. `
        + 'Left unfixed the snapshot ages out and the corpus build fails.',
    });
  }

  return {
    alert: reasons.length > 0,
    reasons,
    snapshot,
    lastRun: lastRun ? { ...lastRun, superseded } : lastRun,
  };
}

function statusLines({ snapshot, lastRun }) {
  return [
    snapshot
      ? `Newest snapshot: \`${snapshot.filename}\` captured ${snapshot.capturedAt}, `
        + `${Math.floor(snapshot.ageDays)} day(s) old.`
      : `No snapshot found in \`${SNAPSHOT_DIR}\`.`,
    lastRun?.unknown ? 'Last refresh run: UNKNOWN (listing could not be corroborated).' : lastRun?.conclusion
      ? `Last refresh run: \`${lastRun.conclusion}\`${lastRun.url ? ` — [run](${lastRun.url})` : ''}`
        + `${lastRun.superseded ? ', superseded by the newer snapshot above' : ''}.`
      : 'Last refresh run: none found.',
  ];
}

export function renderBody(verdict, { runUrl = '' } = {}) {
  const { reasons } = verdict;
  return [
    `The crawlable live-pulse snapshot needs attention: ${reasons.length} finding(s).`,
    '',
    ...statusLines(verdict),
    // null, not '': the join below keeps deliberate blank separators, because
    // markdown needs them between a paragraph and the list that follows.
    runUrl ? `Detected by [this monitor run](${runUrl}).` : null,
    '',
    ...reasons.map((reason) => `- **${reason.kind}** — ${reason.detail}`),
    '',
    'Refresh with the workflow rather than by hand where possible: run '
      + `[${REFRESH_WORKFLOW}](../actions/workflows/${REFRESH_WORKFLOW}) via workflow_dispatch, `
      + 'then merge the review PR it opens.',
    '',
    'A manual freeze needs `WORLDMONITOR_API_KEY` in `.env.local`, and both follow-ups: '
      + '`npm run teasers:welcome` and `npm run build:llms-full`. A keyless run exits 0 and '
      + 'writes a snapshot with zero country briefs, so check `coverage.briefCountryCount` '
      + 'before committing.',
    '',
    'This issue is reused while the condition persists and closed by the monitor once it clears.',
  ].filter((line) => line !== null).join('\n');
}

export function renderRecovery(verdict, { runUrl = '' } = {}) {
  return [
    'The crawlable live-pulse snapshot is healthy again.',
    '',
    ...statusLines(verdict),
    // Posted before the close request, so it must not claim the close happened.
    runUrl ? `Recovery detected by [this monitor run](${runUrl}).` : null,
  ].filter((line) => line !== null).join('\n');
}

export function publishPulseFreshness(verdict, {
  repository = process.env.GITHUB_REPOSITORY,
  runUrl = '',
  summaryPath,
  gh = ghJson,
  ghPost = ghWrite,
} = {}) {
  if (!verdict.alert && verdict.lastRun?.unknown) {
    const message = 'UNKNOWN: pulse refresh run listing could not be corroborated; existing issue left unchanged.';
    if (summaryPath) appendFileSync(summaryPath, `${message}\n`);
    return { alert: false, state: 'UNKNOWN', action: 'unchanged' };
  }
  const body = renderBody(verdict, { runUrl });
  if (summaryPath) appendFileSync(summaryPath, `${body}\n`);
  if (!repository) {
    if (!verdict.alert) return { alert: false };
    throw new Error('GITHUB_REPOSITORY is required to publish pulse freshness findings');
  }

  const pages = gh(['api', '--paginate', '--slurp', `repos/${repository}/issues?state=open&per_page=100`]);
  const existing = pages.flat().find((issue) => !issue.pull_request && issue.title === ISSUE_TITLE);
  if (!verdict.alert) {
    if (!existing) return { alert: false };
    // A comment notifies subscribers; a body PATCH does not. Closing on
    // recovery also makes the next finding a fresh issue instead of a silent
    // edit to one nobody is watching any more.
    ghPost(['api', `repos/${repository}/issues/${existing.number}/comments`, '--input', '-'], {
      body: renderRecovery(verdict, { runUrl }),
    });
    ghPost(['api', '--method', 'PATCH', `repos/${repository}/issues/${existing.number}`, '--input', '-'], {
      state: 'closed',
      state_reason: 'completed',
    });
    return { alert: false, action: 'closed' };
  }
  const endpoint = `repos/${repository}/issues${existing ? `/${existing.number}` : ''}`;
  ghPost(['api', '--method', existing ? 'PATCH' : 'POST', endpoint, '--input', '-'], {
    title: ISSUE_TITLE,
    body,
  });
  return { alert: true, reasons: verdict.reasons.length, action: existing ? 'updated' : 'created' };
}

export function readLastRefreshRun({ repository = process.env.GITHUB_REPOSITORY, gh = ghJson, clock = Date.now, sampleBudgetMs = 90_000 } = {}) {
  if (!repository) return null;
  const listings = corroborateRunListings({
    workflowFile: REFRESH_WORKFLOW, clock, sampleBudgetMs,
    read: () => {
      const payload = gh([
        'api',
        `repos/${repository}/actions/workflows/${REFRESH_WORKFLOW}/runs?per_page=1&status=completed`,
      ]);
      if (!Array.isArray(payload?.workflow_runs) || payload.workflow_runs.some(run => !run?.id || !Number.isFinite(Date.parse(run.created_at)))) {
        throw new Error('refresh run listing has unreadable workflow runs');
      }
      return { runs: payload.workflow_runs, totalCount: payload.total_count };
    },
  });
  const run = reduceRunListings(listings)[0];
  if (!run) return null;
  return {
    conclusion: run.conclusion ?? null,
    url: run.html_url ?? '',
    createdAt: run.created_at ?? '',
    completedAt: run.updated_at ?? run.created_at ?? '',
  };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    const snapshot = readNewestSnapshot(process.cwd());
    let lastRun;
    try {
      lastRun = readLastRefreshRun();
    } catch {
      console.log('::warning::UNKNOWN: pulse refresh run listing could not be corroborated.');
      lastRun = { unknown: true };
    }
    const verdict = evaluatePulseFreshness(snapshot, lastRun);
    const runUrl = process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : '';
    console.log(JSON.stringify(publishPulseFreshness(verdict, {
      runUrl,
      summaryPath: process.env.GITHUB_STEP_SUMMARY,
    })));
  } catch (error) {
    console.error(`Pulse freshness monitor could not report: ${error.message}`);
    process.exitCode = 1;
  }
}
