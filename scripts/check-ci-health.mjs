#!/usr/bin/env node
// Weekly CI health scan: four deterministic detectors over the workflows that
// gate merges, each finding kept as one rolling GitHub issue.
//
//   flaky     a job failed, then passed when the same run was re-run
//   timeout   a job on a push to main was cancelled after running 10+ minutes
//             (push runs on main are not superseded, so this is a job timeout;
//             unit-shard (5) hung silently for 14 minutes on 2098d920ae)
//   failing   a workflow's two newest decided runs on main both failed
//   slower    a job's median time on successful main runs rose 20% and 30s+
//             week over week. Samples come from 15 runs per week, so a
//             path-filtered job that ran in fewer than 5 of them is not judged;
//             covering those would mean reading every main run's jobs.
//
// Issues are matched by exact title and must have been opened by the scan
// itself (github-actions[bot]). An open match has its body replaced with the
// newest evidence; otherwise a new issue is opened. Nothing is closed
// automatically: a person decides when a finding is fixed.
//
// Workflow and job names reach issues from pull_request runs, whose workflow
// file a fork controls, so every name is reduced to a plain label first.
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { corroborateRunListings, reduceRunListings } from './lib/gh-run-listing.mjs';
import { isMainModule } from './lib/main-module.mjs';

export const MONITORED_WORKFLOWS = ['test.yml', 'typecheck.yml', 'lint-code.yml', 'proto-check.yml'];
export const ISSUE_AUTHOR = 'github-actions[bot]';
const DAY_MS = 86_400_000;
const WINDOW_DAYS = 7;
// The weekly cron fires late by minutes to hours. Event detectors look back a
// little further than a week so nothing falls between two scans; an overlap
// only re-updates an issue.
const EVENT_OVERLAP_MS = 6 * 3_600_000;
const TIMEOUT_MIN_SECONDS = 600;
const RERUNS_PER_WORKFLOW = 60;
const MAIN_LISTING_SIZE = 30;
// An aggregate job (`unit`, `proto-freshness`) starts after the jobs it needs
// finish and fails within seconds when one of them failed. That failure is the
// dependency's, not its own. Independent jobs start with the run, so they are
// never excused this way, however fast they fail.
const DEPENDENT_FAILURE_SECONDS = 15;
export const SLOWDOWN = { ratio: 1.2, minSeconds: 30, minSamples: 5, samplesPerWindow: 15 };

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function jobSeconds(job) {
  if (!job.started_at || !job.completed_at) return null;
  return (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000;
}

// Keep names readable but inert: no mentions, issue references, URLs, markup
// or table breaks. GitHub autolinks a bare `www.` host even after `_`.
export function safeLabel(value) {
  const label = String(value ?? '').replace(/[^\w .,()+-]/g, '_').replace(/www\./gi, 'www_')
    .replace(/\s+/g, ' ').trim();
  return (label || '_').slice(0, 100);
}

function evidence(run, detail) {
  return { url: run.html_url, sha: run.head_sha.slice(0, 10), at: run.created_at, detail };
}

function addFinding(findings, finding, item) {
  const existing = findings.get(finding.title);
  if (existing) existing.evidence.push(item);
  else findings.set(finding.title, { ...finding, evidence: [item] });
}

export function inheritedFailure(job, jobs) {
  const seconds = jobSeconds(job);
  if (seconds === null || seconds >= DEPENDENT_FAILURE_SECONDS) return false;
  const started = Date.parse(job.started_at);
  // A dependency that timed out ends `cancelled`, not `failure`.
  return jobs.some((other) => other !== job && (other.conclusion === 'failure' || other.conclusion === 'cancelled')
    && other.completed_at && Date.parse(other.completed_at) <= started);
}

// reruns: [{ run, attempts: [[job, ...] per attempt, oldest first] }]
export function findFlakyJobs(reruns) {
  const findings = new Map();
  for (const { run, attempts } of reruns) {
    const final = attempts.at(-1) ?? [];
    for (const job of final) {
      if (job.conclusion !== 'success') continue;
      const failedAt = attempts.slice(0, -1).findIndex((jobs) => jobs.some((earlier) => (
        earlier.name === job.name && earlier.conclusion === 'failure' && !inheritedFailure(earlier, jobs)
      )));
      if (failedAt === -1) continue;
      const workflow = safeLabel(run.name);
      const name = safeLabel(job.name);
      addFinding(findings, {
        kind: 'flaky',
        title: `CI health (flaky): ${workflow} / ${name}`,
        summary: `\`${name}\` in **${workflow}** failed, then passed when the same commit was re-run.`,
      }, evidence(run, `failed on attempt ${failedAt + 1}, passed on attempt ${attempts.length}`));
    }
  }
  return [...findings.values()];
}

// mainAttempts: [{ run, attempt, jobs }] for push runs on main
export function findTimeouts(mainAttempts) {
  const findings = new Map();
  for (const { run, attempt, jobs } of mainAttempts) {
    for (const job of jobs) {
      const seconds = jobSeconds(job);
      if (job.conclusion !== 'cancelled' || seconds === null || seconds < TIMEOUT_MIN_SECONDS) continue;
      const workflow = safeLabel(run.name);
      const name = safeLabel(job.name);
      addFinding(findings, {
        kind: 'timeout',
        title: `CI health (timeout): ${workflow} / ${name}`,
        summary: `\`${name}\` in **${workflow}** was cancelled on main after running ${Math.round(seconds / 60)}+ minutes, which on a push to main means it hit its job timeout.`,
      }, evidence(run, `attempt ${attempt} cancelled after ${Math.round(seconds)}s`));
    }
  }
  return [...findings.values()];
}

// mainRuns: push runs on main for one workflow, any order
export function findFailingMain(mainRuns) {
  const decided = mainRuns
    .filter((run) => run.status === 'completed' && (run.conclusion === 'success' || run.conclusion === 'failure'))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  if (decided.length < 2 || decided[0].conclusion !== 'failure' || decided[1].conclusion !== 'failure') return [];
  const firstPass = decided.findIndex((run) => run.conclusion !== 'failure');
  const streak = firstPass === -1 ? decided : decided.slice(0, firstPass);
  const workflow = safeLabel(decided[0].name);
  return [{
    kind: 'failing',
    title: `CI health (failing on main): ${workflow}`,
    summary: `**${workflow}**'s ${streak.length} newest decided runs on main failed.`,
    evidence: streak.slice(0, 10).map((run) => evidence(run, 'failure')),
  }];
}

// samples: [{ workflow, job, window: 'current' | 'previous', seconds, steps, run }]
export function findSlowdowns(samples) {
  const groups = new Map();
  for (const sample of samples) {
    const key = `${sample.workflow}\u0000${sample.job}`;
    if (!groups.has(key)) groups.set(key, { current: [], previous: [], steps: { current: new Set(), previous: new Set() }, sample });
    const group = groups.get(key);
    group[sample.window].push(sample.seconds);
    for (const step of sample.steps ?? []) group.steps[sample.window].add(step);
  }
  const findings = [];
  for (const { current, previous, steps, sample } of groups.values()) {
    if (current.length < SLOWDOWN.minSamples || previous.length < SLOWDOWN.minSamples) continue;
    const now = median(current);
    const before = median(previous);
    if (now < before * SLOWDOWN.ratio || now - before < SLOWDOWN.minSeconds) continue;
    const workflow = safeLabel(sample.workflow);
    const name = safeLabel(sample.job);
    // A slowdown is often a step someone added on purpose. Say so up front.
    const added = [...steps.current].filter((step) => !steps.previous.has(step)).map(safeLabel);
    findings.push({
      kind: 'slower',
      title: `CI health (slower): ${workflow} / ${name}`,
      summary: `\`${name}\` in **${workflow}** takes a median ${Math.round(now)}s on successful main runs this week, up from ${Math.round(before)}s the week before (+${Math.round((now / before - 1) * 100)}%).`
        + (added.length ? ` Steps new this week: ${added.map((step) => `\`${step}\``).join(', ')}.` : ''),
      evidence: [{ url: sample.run.html_url, sha: sample.run.head_sha.slice(0, 10), at: sample.run.created_at, detail: `${current.length} runs this week, ${previous.length} the week before` }],
    });
  }
  return findings;
}

export function formatIssueBody(finding, generatedAt) {
  const rows = finding.evidence.slice(0, 20).map((item) => `| ${item.at.slice(0, 16).replace('T', ' ')} | \`${item.sha}\` | ${item.detail} | [run](${item.url}) |`);
  return [
    finding.summary,
    '',
    '| When (UTC) | Commit | Detail | Run |',
    '|---|---|---|---|',
    ...rows,
    '',
    `Updated by the weekly CI health scan (\`scripts/check-ci-health.mjs\`) on ${generatedAt.slice(0, 10)}. Close this issue once it is fixed; a later recurrence opens a new one.`,
  ].join('\n');
}

export function syncIssues({ findings, issues, generatedAt }) {
  const actions = [];
  for (const finding of findings) {
    const body = formatIssueBody(finding, generatedAt);
    const open = issues.search(finding.title);
    if (open) {
      issues.update(open.number, body);
      actions.push({ action: 'updated', number: open.number, title: finding.title });
    } else {
      const created = issues.create(finding.title, body);
      actions.push({ action: 'created', number: created.number, title: finding.title });
    }
  }
  return actions;
}

function defaultGh(args, options = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
}

// Only an issue the scan opened may be rewritten: the repository is public,
// so anyone can open an issue whose title matches a finding.
export function pickOwnedIssue(items, title) {
  return items.find((issue) => issue.title === title && issue.user?.login === ISSUE_AUTHOR && !issue.pull_request) ?? null;
}

function githubIssues(gh, repository) {
  return {
    search(title) {
      const { items } = JSON.parse(gh([
        'api', '-X', 'GET', 'search/issues',
        '-f', `q=repo:${repository} is:issue is:open in:title "${title}"`,
        '-f', 'per_page=50',
      ]));
      return pickOwnedIssue(items, title);
    },
    create(title, body) {
      return JSON.parse(gh(['api', `repos/${repository}/issues`, '--input', '-'], { input: JSON.stringify({ title, body }) }));
    },
    update(number, body) {
      gh(['api', `repos/${repository}/issues/${number}`, '--method', 'PATCH', '--input', '-'], { input: JSON.stringify({ body }) });
    },
  };
}

function api(gh, path) {
  return JSON.parse(gh(['api', path]));
}

function listRuns(gh, repository, workflow, query) {
  const runs = [];
  for (let page = 1; ; page += 1) {
    const { workflow_runs: batch } = api(gh, `repos/${repository}/actions/workflows/${workflow}/runs?${query}&per_page=100&page=${page}`);
    runs.push(...batch);
    if (batch.length < 100) return runs;
  }
}

function day(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// The newest main runs, read three times and reduced the way the deploy
// monitors do: GitHub sometimes answers with a stale index snapshot, and a
// stale view could raise or hide a failing-main alarm.
function newestMainRuns(gh, repository, workflow) {
  const listings = corroborateRunListings({
    workflowFile: workflow,
    read: () => {
      const payload = api(gh, `repos/${repository}/actions/workflows/${workflow}/runs?event=push&branch=main&per_page=${MAIN_LISTING_SIZE}`);
      return { runs: payload.workflow_runs, totalCount: payload.total_count };
    },
  });
  return reduceRunListings(listings);
}

export function collect({ gh, repository, now }) {
  const jobsCache = new Map();
  const attemptJobs = (run, attempt) => {
    const key = `${run.id}/${attempt}`;
    if (!jobsCache.has(key)) jobsCache.set(key, api(gh, `repos/${repository}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`).jobs);
    return jobsCache.get(key);
  };
  const allAttempts = (run) => Array.from({ length: run.run_attempt }, (_, index) => attemptJobs(run, index + 1));

  const eventStart = now - WINDOW_DAYS * DAY_MS - EVENT_OVERLAP_MS;
  const currentStart = now - WINDOW_DAYS * DAY_MS;
  const reruns = [];
  const mainAttempts = [];
  const samples = [];
  const failing = [];
  for (const workflow of MONITORED_WORKFLOWS) {
    // The runs API stops at 1,000 results per filtered query, and these
    // workflows run ~150 times a day, so the window is read one calendar day
    // at a time, then cut to the exact window.
    const days = new Set();
    for (let ms = eventStart; ms < now + DAY_MS; ms += DAY_MS) days.add(day(Math.min(ms, now)));
    const window = [...days]
      .flatMap((date) => listRuns(gh, repository, workflow, `created=${date}`))
      .filter((run) => Date.parse(run.created_at) >= eventStart && run.status === 'completed');

    // Days are read oldest first; the cap keeps the newest re-runs.
    const newestReruns = window.filter((item) => item.run_attempt > 1)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, RERUNS_PER_WORKFLOW);
    for (const run of newestReruns) {
      reruns.push({ run, attempts: allAttempts(run) });
    }
    // A timed-out attempt survives a later successful re-run, so every
    // attempt of a re-run or unsuccessful main push is read.
    for (const run of window.filter((item) => item.event === 'push' && item.head_branch === 'main'
      && (item.run_attempt > 1 || item.conclusion === 'cancelled' || item.conclusion === 'failure'))) {
      allAttempts(run).forEach((jobs, index) => mainAttempts.push({ run, attempt: index + 1, jobs }));
    }

    failing.push(...findFailingMain(newestMainRuns(gh, repository, workflow)));

    const main = listRuns(gh, repository, workflow, `event=push&branch=main&status=success&created=>=${day(now - 2 * WINDOW_DAYS * DAY_MS)}`)
      .filter((item) => item.run_attempt === 1 && Date.parse(item.created_at) >= now - 2 * WINDOW_DAYS * DAY_MS);
    for (const [period, runs] of [
      ['current', main.filter((item) => Date.parse(item.created_at) >= currentStart)],
      ['previous', main.filter((item) => Date.parse(item.created_at) < currentStart)],
    ]) {
      for (const run of runs.slice(0, SLOWDOWN.samplesPerWindow)) {
        for (const job of attemptJobs(run, 1)) {
          const seconds = jobSeconds(job);
          if (job.conclusion !== 'success' || seconds === null) continue;
          samples.push({ workflow: run.name, job: job.name, window: period, seconds, steps: (job.steps ?? []).map((step) => step.name), run });
        }
      }
    }
  }
  return [...failing, ...findTimeouts(mainAttempts), ...findFlakyJobs(reruns), ...findSlowdowns(samples)];
}

export function checkCiHealth({ gh = defaultGh, repository, now = Date.now(), dryRun = false, issues } = {}) {
  const findings = collect({ gh, repository, now });
  const generatedAt = new Date(now).toISOString();
  const actions = dryRun ? [] : syncIssues({ findings, issues: issues ?? githubIssues(gh, repository), generatedAt });
  return { findings, actions };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string', default: process.env.GITHUB_REPOSITORY || 'koala73/worldmonitor' },
      'dry-run': { type: 'boolean', default: false },
      output: { type: 'string' },
    },
  });
  try {
    const { findings, actions } = checkCiHealth({ repository: values.repo, dryRun: values['dry-run'] });
    if (values.output) writeFileSync(values.output, `${JSON.stringify(findings, null, 2)}\n`);
    const lines = findings.length
      ? findings.map((finding) => `- ${finding.title} (${finding.evidence.length} occurrence${finding.evidence.length === 1 ? '' : 's'})`)
      : ['- No findings.'];
    for (const action of actions) lines.push(`- ${action.action} #${action.number}: ${action.title}`);
    console.log(lines.join('\n'));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## CI health\n\n${lines.join('\n')}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
