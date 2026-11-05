#!/usr/bin/env node
// Weekly CI health scan: four deterministic detectors over the workflows that
// gate merges, each finding kept as one rolling GitHub issue.
//
//   flaky     a job failed, then passed when the same run was re-run. Pull
//             request runs count: a re-run tests the same commit, so a flip is
//             a flake whatever the branch. The failed attempt's log names the
//             failing tests, and a flake whose named test files have all
//             changed on main since it failed is not reported, unless the log
//             came from a fork, which writes its own (#10013, #10016
//             were filed days after their fixes merged). A recurrence after
//             that change is newer than it, so it is reported.
//   timeout   a job on a push to main was cancelled after running 10+ minutes
//             (push runs on main are not superseded, so this is a job timeout;
//             unit-shard (5) hung silently for 14 minutes on 2098d920ae)
//   failing   a workflow's two newest decided runs on main both failed
//   slower    a job's median time on successful main runs rose 20% and 30s+
//             week over week. Samples are 15 runs spread across each week: the
//             15 newest are one busy day, and runner speed alone moves a job
//             between ~125s and ~175s from one day to the next (#10018). A
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
// Failed-attempt logs read per scan, newest flakes first. Each is one API call
// plus one lookup per named test file.
const FLAKE_LOGS_PER_SCAN = 40;
const TESTS_PER_EVIDENCE = 5;
const FILES_PER_ATTRIBUTION = 20;
const ASSOCIATION_LOOKUPS = 3;
// A test path from a fork-controlled log is copied into an issue body, which
// GitHub rejects above 65,536 characters. Real paths here stay under 120.
const MAX_TEST_PATH = 200;

// `count` runs spread evenly over `runs` ordered by creation time, oldest
// first, always keeping the oldest and the newest.
export function spreadSample(runs, count) {
  const ordered = [...runs].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  if (ordered.length <= count) return ordered;
  if (count === 1) return [ordered.at(-1)];
  return Array.from({ length: count }, (_, index) => ordered[Math.round(index * (ordered.length - 1) / (count - 1))]);
}

// A repo-relative test path and line, or nothing. Logs are fork-controlled on
// pull_request runs, so only this exact shape ever reaches an issue: a plain
// top-level directory (tests are spread over a dozen, src-tauri/ and
// consumer-prices-core/ among them), no scheme, no `..`, no markup.
const TEST_PATH = /^[a-z][\w-]*\/(?:[\w-][\w.-]*\/)*[\w-][\w.-]*\.(?:test|spec)\.[cm]?[jt]sx?(?::\d+(?::\d+)?)?$/;
const FAILING_TEST_PATTERNS = [
  // node:test, in its "failing tests:" summary
  /^test at (\S+)$/,
  // scripts/run-data-tests.mjs watchdog
  /^Data test file still running after --file-timeout=\d+ms \(a test hung or a handle was left open\): (\S+)$/,
  // Playwright list reporter: "  1) [chromium] › e2e/x.spec.ts:474:3 › title"
  /^\d+\) \[[\w-]+\] › (\S+) ›/,
  // vitest: " FAIL  tests/dom/x.test.mts > suite > test"
  /^FAIL\s+(\S+)(?:\s|$)/,
];

export function parseFailingTests(log) {
  const found = new Set();
  for (const raw of String(log).split('\n')) {
    // Strip the runner's timestamp prefix and colour codes.
    const line = raw.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\x1b\[[\d;]*m/g, '').trim();
    for (const pattern of FAILING_TEST_PATTERNS) {
      const path = pattern.exec(line)?.[1]?.replace(/^\.\//, '');
      if (path && path.length <= MAX_TEST_PATH && TEST_PATH.test(path)) found.add(path);
    }
  }
  // Prefer file:line entries; drop a bare file when a line entry names it.
  return [...found].filter((path) => path.includes(':') || ![...found].some((other) => other.startsWith(`${path}:`)));
}

function runOrigin(run) {
  if (run.event === 'push' && run.head_branch === 'main') return 'main';
  if (run.event === 'pull_request') return 'pull request';
  return safeLabel(run.event ?? 'unknown');
}

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
      const isOwnFailure = (earlier, jobs) => earlier.name === job.name && earlier.conclusion === 'failure' && !inheritedFailure(earlier, jobs);
      const failedAt = attempts.slice(0, -1).findIndex((jobs) => jobs.some((earlier) => isOwnFailure(earlier, jobs)));
      if (failedAt === -1) continue;
      // Every failed attempt of this job: each can fail in a different test.
      const failedJobIds = attempts.slice(0, -1)
        .flatMap((jobs) => jobs.filter((earlier) => isOwnFailure(earlier, jobs)))
        .map((earlier) => earlier.id)
        .filter(Boolean);
      const workflow = safeLabel(run.name);
      const name = safeLabel(job.name);
      addFinding(findings, {
        kind: 'flaky',
        title: `CI health (flaky): ${workflow} / ${name}`,
        summary: `\`${name}\` in **${workflow}** failed, then passed when the same commit was re-run.`,
      }, {
        ...evidence(run, `${runOrigin(run)}: failed on attempt ${failedAt + 1}, passed on attempt ${attempts.length}`),
        failedJobIds,
        pullRequests: (run.pull_requests ?? []).map((pull) => pull.number).filter(Number.isSafeInteger),
        // A fork's job log is the contributor's own text: it may name tests in
        // the issue but never decides that a flake was fixed. Unknown
        // provenance counts as a fork.
        trustedLog: Boolean(run.repository?.full_name) && run.head_repository?.full_name === run.repository.full_name,
      });
    }
  }
  return [...findings.values()];
}

// Name each flake's failing tests from its failed attempt's log, and drop a
// flake whose named test files have all changed on main since it failed.
//   readLog(jobId) -> log text (throws when unreadable)
//   changeSince(file, iso, pullRequests) -> short sha of the first main commit
//     touching `file` at or after `iso`, ignoring the merge of the flaking pull
//     request itself, or null
// A row whose log or history is unreadable, or whose log names no test, is
// kept: without a name there is nothing to prove the flake was addressed. So is
// a row from a fork, whose log the contributor writes and could fill with any
// recently changed test.
export function attributeFlakes(findings, { readLog, changeSince, limit = FLAKE_LOGS_PER_SCAN }) {
  const rows = findings.filter((finding) => finding.kind === 'flaky')
    .flatMap((finding) => finding.evidence)
    .filter((row) => row.failedJobIds?.length)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);
  const warnings = [];
  for (const row of rows) {
    // Every failed attempt must name its tests before any can be called fixed.
    const tests = new Set();
    let attributed = true;
    for (const jobId of row.failedJobIds) {
      let named;
      try {
        named = parseFailingTests(readLog(jobId));
      } catch (error) {
        warnings.push(`log for job ${jobId} unreadable: ${safeLabel(error.message)}`);
        attributed = false;
        continue;
      }
      if (!named.length) attributed = false;
      named.forEach((test) => tests.add(test));
    }
    if (!tests.size) continue;
    const shown = [...tests].slice(0, TESTS_PER_EVIDENCE);
    const more = tests.size - shown.length;
    row.detail += ` · failing: ${shown.map((test) => `\`${test}\``).join(', ')}${more ? ` and ${more} more` : ''}`;
    if (!attributed || !row.trustedLog) continue;
    // The display is capped; the decision reads every named file.
    const files = [...new Set([...tests].map((test) => test.replace(/:\d+(?::\d+)?$/, '')))];
    // A mass failure is a broken run, not one flake: keep it rather than spend
    // a history lookup per file.
    if (files.length > FILES_PER_ATTRIBUTION) continue;
    const changes = files.map((file) => {
      try {
        return changeSince(file, row.at, row.pullRequests ?? []);
      } catch (error) {
        warnings.push(`history of ${file} unreadable: ${safeLabel(error.message)}`);
        return null;
      }
    });
    if (changes.every(Boolean)) {
      row.changedSince = [...new Set(changes)];
      row.detail += ` · changed on main since: ${row.changedSince.map((sha) => `\`${sha}\``).join(', ')}`;
    }
  }
  const kept = [];
  const skipped = [];
  for (const finding of findings) {
    if (finding.kind === 'flaky' && finding.evidence.every((row) => row.changedSince)) skipped.push(finding.title);
    else kept.push(finding);
  }
  return { findings: kept, skipped, warnings };
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
    // One rejected write must not drop every finding after it.
    try {
      const open = issues.search(finding.title);
      if (open) {
        issues.update(open.number, body);
        actions.push({ action: 'updated', number: open.number, title: finding.title });
      } else {
        const created = issues.create(finding.title, body);
        actions.push({ action: 'created', number: created.number, title: finding.title });
      }
    } catch (error) {
      actions.push({ action: 'failed', number: null, title: finding.title, error: safeLabel(error.message) });
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
      // Newest first: a finding links the first sample it saw.
      for (const run of spreadSample(runs, SLOWDOWN.samplesPerWindow).reverse()) {
        for (const job of attemptJobs(run, 1)) {
          const seconds = jobSeconds(job);
          if (job.conclusion !== 'success' || seconds === null) continue;
          samples.push({ workflow: run.name, job: job.name, window: period, seconds, steps: (job.steps ?? []).map((step) => step.name), run });
        }
      }
    }
  }
  const all = [...failing, ...findTimeouts(mainAttempts), ...findFlakyJobs(reruns), ...findSlowdowns(samples)];
  return attributeFlakes(all, {
    // The log endpoint answers raw text that may carry colour codes, which gh
    // refuses to print unless told to.
    readLog: (jobId) => gh(['api', '--allow-escape-sequences', `repos/${repository}/actions/jobs/${jobId}/logs`]),
    changeSince: (file, iso, pullRequests) => {
      const commits = api(gh, `repos/${repository}/commits?sha=main&path=${encodeURIComponent(file)}&since=${encodeURIComponent(iso)}&per_page=20`);
      const ownSubject = (message) => pullRequests.some((number) => String(message ?? '').split('\n')[0].includes(`(#${number})`));
      // Oldest first: the first change after the flake that is not the flaking
      // pull request's own merge. A merge subject may lack `(#N)`, so ask
      // GitHub which pull requests each candidate belongs to, a few at most;
      // an unresolved candidate keeps the flake reported.
      const candidates = commits.filter((commit) => !ownSubject(commit.commit?.message)).reverse();
      if (!pullRequests.length) return candidates[0]?.sha.slice(0, 10) ?? null;
      for (const commit of candidates.slice(0, ASSOCIATION_LOOKUPS)) {
        const pulls = api(gh, `repos/${repository}/commits/${commit.sha}/pulls`);
        if (!pulls.some((pull) => pullRequests.includes(pull.number))) return commit.sha.slice(0, 10);
      }
      return null;
    },
  });
}

export function checkCiHealth({ gh = defaultGh, repository, now = Date.now(), dryRun = false, issues } = {}) {
  const { findings, skipped, warnings } = collect({ gh, repository, now });
  const generatedAt = new Date(now).toISOString();
  const actions = dryRun ? [] : syncIssues({ findings, issues: issues ?? githubIssues(gh, repository), generatedAt });
  return { findings, actions, skipped, warnings };
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
    const { findings, actions, skipped, warnings } = checkCiHealth({ repository: values.repo, dryRun: values['dry-run'] });
    if (values.output) writeFileSync(values.output, `${JSON.stringify(findings, null, 2)}\n`);
    const lines = findings.length
      ? findings.map((finding) => `- ${finding.title} (${finding.evidence.length} occurrence${finding.evidence.length === 1 ? '' : 's'})`)
      : ['- No findings.'];
    for (const title of skipped) lines.push(`- not reported, its failing tests changed on main since: ${title}`);
    for (const warning of warnings) lines.push(`- warning: ${warning}`);
    for (const action of actions) {
      lines.push(action.action === 'failed'
        ? `- failed to sync: ${action.title} (${action.error})`
        : `- ${action.action} #${action.number}: ${action.title}`);
    }
    if (actions.some((action) => action.action === 'failed')) process.exitCode = 1;
    console.log(lines.join('\n'));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## CI health\n\n${lines.join('\n')}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
