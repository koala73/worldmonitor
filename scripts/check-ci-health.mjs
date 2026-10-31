#!/usr/bin/env node
// Weekly CI health scan: three deterministic detectors over the workflows that
// gate merges, each finding kept as one rolling GitHub issue.
//
//   flaky     a job failed, then passed when the same run was re-run
//   timeout   a job on a push to main was cancelled after running 10+ minutes
//             (push runs on main are not superseded, so this is a job timeout;
//             unit-shard (5) hung silently for 14 minutes on 2098d920ae)
//   failing   a workflow's two newest decided runs on main both failed
//   slower    a job's median time on successful main runs rose 20% and 30s+
//             week over week
//
// Issues are matched by exact title. An open match has its body replaced with
// the newest evidence; otherwise a new issue is opened. Nothing is closed
// automatically: a person decides when a finding is fixed.
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { isMainModule } from './lib/main-module.mjs';

export const MONITORED_WORKFLOWS = ['test.yml', 'typecheck.yml', 'lint-code.yml', 'proto-check.yml'];
const DAY_MS = 86_400_000;
const WINDOW_DAYS = 7;
const TIMEOUT_MIN_SECONDS = 600;
const RERUNS_PER_WORKFLOW = 60;
// An aggregate job (`unit`, `gate`) fails within seconds when a job it needs
// failed. That is the dependency's failure, not its own.
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

function evidence(run, detail) {
  return { url: run.html_url, sha: run.head_sha.slice(0, 10), at: run.created_at, detail };
}

function addFinding(findings, finding, item) {
  const existing = findings.get(finding.title);
  if (existing) existing.evidence.push(item);
  else findings.set(finding.title, { ...finding, evidence: [item] });
}

// reruns: [{ run, attempts: [[job, ...] per attempt, oldest first] }]
export function findFlakyJobs(reruns) {
  const findings = new Map();
  for (const { run, attempts } of reruns) {
    const final = attempts.at(-1) ?? [];
    for (const job of final) {
      if (job.conclusion !== 'success') continue;
      const failedAt = attempts.slice(0, -1).findIndex((jobs) => jobs.some((earlier) => {
        if (earlier.name !== job.name || earlier.conclusion !== 'failure') return false;
        const inherited = (jobSeconds(earlier) ?? 0) < DEPENDENT_FAILURE_SECONDS
          && jobs.some((other) => other !== earlier && other.conclusion === 'failure');
        return !inherited;
      }));
      if (failedAt === -1) continue;
      addFinding(findings, {
        kind: 'flaky',
        title: `CI health (flaky): ${run.name} / ${job.name}`,
        summary: `\`${job.name}\` in **${run.name}** failed, then passed when the same commit was re-run.`,
      }, evidence(run, `failed on attempt ${failedAt + 1}, passed on attempt ${attempts.length}`));
    }
  }
  return [...findings.values()];
}

// mainJobs: [{ run, jobs }] for failed or cancelled push runs on main
export function findTimeouts(mainJobs) {
  const findings = new Map();
  for (const { run, jobs } of mainJobs) {
    for (const job of jobs) {
      const seconds = jobSeconds(job);
      if (job.conclusion !== 'cancelled' || seconds === null || seconds < TIMEOUT_MIN_SECONDS) continue;
      addFinding(findings, {
        kind: 'timeout',
        title: `CI health (timeout): ${run.name} / ${job.name}`,
        summary: `\`${job.name}\` in **${run.name}** was cancelled on main after running ${Math.round(seconds / 60)}+ minutes, which on a push to main means it hit its job timeout.`,
      }, evidence(run, `cancelled after ${Math.round(seconds)}s`));
    }
  }
  return [...findings.values()];
}

// mainRuns: completed push runs on main for one workflow, any order
export function findFailingMain(mainRuns) {
  const decided = mainRuns
    .filter((run) => run.status === 'completed' && (run.conclusion === 'success' || run.conclusion === 'failure'))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  if (decided.length < 2 || decided[0].conclusion !== 'failure' || decided[1].conclusion !== 'failure') return [];
  const firstPass = decided.findIndex((run) => run.conclusion !== 'failure');
  const streak = firstPass === -1 ? decided : decided.slice(0, firstPass);
  return [{
    kind: 'failing',
    title: `CI health (failing on main): ${decided[0].name}`,
    summary: `**${decided[0].name}**'s ${streak.length} newest decided runs on main failed.`,
    evidence: streak.slice(0, 10).map((run) => evidence(run, 'failure')),
  }];
}

// samples: [{ workflow, job, window: 'current' | 'previous', seconds, run }]
export function findSlowdowns(samples) {
  const groups = new Map();
  for (const sample of samples) {
    const key = `${sample.workflow}\u0000${sample.job}`;
    if (!groups.has(key)) groups.set(key, { current: [], previous: [], sample });
    groups.get(key)[sample.window].push(sample.seconds);
  }
  const findings = [];
  for (const { current, previous, sample } of groups.values()) {
    if (current.length < SLOWDOWN.minSamples || previous.length < SLOWDOWN.minSamples) continue;
    const now = median(current);
    const before = median(previous);
    if (now < before * SLOWDOWN.ratio || now - before < SLOWDOWN.minSeconds) continue;
    findings.push({
      kind: 'slower',
      title: `CI health (slower): ${sample.workflow} / ${sample.job}`,
      summary: `\`${sample.job}\` in **${sample.workflow}** takes a median ${Math.round(now)}s on successful main runs this week, up from ${Math.round(before)}s the week before (+${Math.round((now / before - 1) * 100)}%).`,
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

function githubIssues(gh, repository) {
  return {
    search(title) {
      const found = JSON.parse(gh([
        'issue', 'list', '--repo', repository, '--state', 'open',
        '--search', `"${title}" in:title`, '--json', 'number,title', '--limit', '20',
      ]) || '[]');
      return found.find((issue) => issue.title === title) ?? null;
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

function attemptJobs(gh, repository, run, attempt) {
  return api(gh, `repos/${repository}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`).jobs;
}

function day(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function collect({ gh, repository, now }) {
  const reruns = [];
  const mainJobs = [];
  const samples = [];
  const failing = [];
  for (const workflow of MONITORED_WORKFLOWS) {
    // The runs API stops at 1,000 results per filtered query, and these
    // workflows run ~150 times a day, so the week is read one day at a time.
    const week = [];
    for (let offset = WINDOW_DAYS - 1; offset >= 0; offset -= 1) {
      week.push(...listRuns(gh, repository, workflow, `created=${day(now - offset * DAY_MS)}`));
    }
    for (const run of week.filter((item) => item.run_attempt > 1 && item.conclusion === 'success').slice(0, RERUNS_PER_WORKFLOW)) {
      const attempts = [];
      for (let attempt = 1; attempt <= run.run_attempt; attempt += 1) attempts.push(attemptJobs(gh, repository, run, attempt));
      reruns.push({ run, attempts });
    }
    const main = listRuns(gh, repository, workflow, `event=push&branch=main&created=>=${day(now - 2 * WINDOW_DAYS * DAY_MS)}`);
    failing.push(...findFailingMain(main));
    const currentStart = now - WINDOW_DAYS * DAY_MS;
    for (const run of main.filter((item) => Date.parse(item.created_at) >= currentStart && (item.conclusion === 'cancelled' || item.conclusion === 'failure'))) {
      mainJobs.push({ run, jobs: attemptJobs(gh, repository, run, run.run_attempt) });
    }
    const successful = main.filter((item) => item.conclusion === 'success' && item.run_attempt === 1);
    for (const [window, runs] of [
      ['current', successful.filter((item) => Date.parse(item.created_at) >= currentStart)],
      ['previous', successful.filter((item) => Date.parse(item.created_at) < currentStart)],
    ]) {
      for (const run of runs.slice(0, SLOWDOWN.samplesPerWindow)) {
        for (const job of attemptJobs(gh, repository, run, 1)) {
          const seconds = jobSeconds(job);
          if (job.conclusion === 'success' && seconds !== null) samples.push({ workflow: run.name, job: job.name, window, seconds, run });
        }
      }
    }
  }
  return [...failing, ...findTimeouts(mainJobs), ...findFlakyJobs(reruns), ...findSlowdowns(samples)];
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
