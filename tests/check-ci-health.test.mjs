import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import YAML from 'yaml';

import {
  MONITORED_WORKFLOWS,
  SLOWDOWN,
  checkCiHealth,
  findFailingMain,
  findFlakyJobs,
  findSlowdowns,
  findTimeouts,
  median,
  pickOwnedIssue,
  safeLabel,
  syncIssues,
} from '../scripts/check-ci-health.mjs';

const NOW = Date.parse('2026-10-31T12:00:00Z');

function run(overrides = {}) {
  return {
    id: 1,
    name: 'Test',
    html_url: 'https://github.com/o/r/actions/runs/1',
    head_sha: '2098d920ae90c98449455e030cfc605a5132864e',
    created_at: '2026-10-31T04:08:21Z',
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
    ...overrides,
  };
}

function job(name, conclusion, seconds = 120, startOffset = 0, steps = []) {
  const started = Date.parse('2026-10-31T04:10:00Z') + startOffset * 1000;
  return {
    name,
    conclusion,
    steps: steps.map((step) => ({ name: step })),
    started_at: new Date(started).toISOString(),
    completed_at: new Date(started + seconds * 1000).toISOString(),
  };
}

describe('median', () => {
  it('handles odd, even and empty inputs', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([]), null);
  });
});

describe('flaky detector', () => {
  it('flags a job that failed and then passed on a re-run of the same run', () => {
    const findings = findFlakyJobs([{
      run: run({ run_attempt: 2 }),
      attempts: [[job('sidecar', 'failure', 40)], [job('sidecar', 'success')]],
    }]);
    assert.deepEqual(findings.map((finding) => finding.title), ['CI health (flaky): Test / sidecar']);
    assert.match(findings[0].evidence[0].detail, /failed on attempt 1, passed on attempt 2/);
  });

  it('does not blame an aggregate job that only failed because a dependency did', () => {
    const findings = findFlakyJobs([{
      run: run({ run_attempt: 2 }),
      attempts: [
        [job('unit-shard (3)', 'failure', 180), job('unit', 'failure', 3, 181)],
        [job('unit-shard (3)', 'success'), job('unit', 'success', 3, 121)],
      ],
    }]);
    assert.deepEqual(findings.map((finding) => finding.title), ['CI health (flaky): Test / unit-shard (3)']);
  });

  it('does not blame an aggregate job whose dependency timed out (cancelled, not failed)', () => {
    // Run 40112988523: the webmcp smoke job hit its 25-minute timeout and
    // variant-smoke-full failed 3 seconds after it ended.
    const findings = findFlakyJobs([{
      run: run({ run_attempt: 2 }),
      attempts: [
        [job('variant-smoke-pro-webmcp (webmcp)', 'cancelled', 1500), job('variant-smoke-full', 'failure', 3, 1503)],
        [job('variant-smoke-pro-webmcp (webmcp)', 'success', 160), job('variant-smoke-full', 'success', 3, 163)],
      ],
    }]);
    assert.deepEqual(findings, []);
  });

  it('still flags a fast job that failed on its own, even beside another failure', () => {
    // public-docs and mintlify-slugs are independent: both start with the run.
    const findings = findFlakyJobs([{
      run: run({ name: 'Lint Code', run_attempt: 2 }),
      attempts: [
        [job('public-docs', 'failure', 9), job('mintlify-slugs', 'failure', 12)],
        [job('public-docs', 'success', 9), job('mintlify-slugs', 'success', 12)],
      ],
    }]);
    assert.deepEqual(findings.map((finding) => finding.title), [
      'CI health (flaky): Lint Code / public-docs',
      'CI health (flaky): Lint Code / mintlify-slugs',
    ]);
  });

  it('reduces fork-controlled workflow and job names to inert labels', () => {
    const findings = findFlakyJobs([{
      run: run({ name: 'Test @koala73 [x](https://evil.example)', run_attempt: 2 }),
      attempts: [[job('<img src=x> | `boom`', 'failure', 40)], [job('<img src=x> | `boom`', 'success')]],
    }]);
    const [finding] = findings;
    for (const text of [finding.title, finding.summary]) {
      assert.doesNotMatch(text, /[@[\]<>|#]|https?:|evil\.example\//);
    }
    assert.equal(safeLabel('unit-shard (5)'), 'unit-shard (5)');
    for (const host of ['www.evil.example', 'Test_www.evil.example', 'x WWW.Evil.example']) {
      assert.doesNotMatch(safeLabel(host), /www\./i, host);
    }
    assert.equal(safeLabel('x'.repeat(300)).length, 100);
  });

  it('ignores jobs that still fail, and groups repeat flakes into one finding', () => {
    const findings = findFlakyJobs([
      { run: run({ run_attempt: 2 }), attempts: [[job('a', 'failure')], [job('a', 'failure')]] },
      { run: run({ id: 2, run_attempt: 2 }), attempts: [[job('b', 'failure')], [job('b', 'success')]] },
      { run: run({ id: 3, run_attempt: 3 }), attempts: [[job('b', 'failure')], [job('b', 'failure')], [job('b', 'success')]] },
    ]);
    assert.deepEqual(findings.map((finding) => [finding.title, finding.evidence.length]), [['CI health (flaky): Test / b', 2]]);
  });
});

describe('timeout detector', () => {
  it('flags a job cancelled on main after ten or more minutes', () => {
    const findings = findTimeouts([{ run: run({ conclusion: 'cancelled' }), attempt: 1, jobs: [
      job('unit-shard (5)', 'cancelled', 916),
      job('unit-shard (1)', 'cancelled', 120),
      job('unit', 'failure', 3),
    ] }]);
    assert.deepEqual(findings.map((finding) => finding.title), ['CI health (timeout): Test / unit-shard (5)']);
    assert.match(findings[0].evidence[0].detail, /attempt 1 cancelled after 916s/);
  });
});

describe('failing-main detector', () => {
  const at = (hour) => `2026-10-31T${String(hour).padStart(2, '0')}:00:00Z`;

  it('flags the two newest decided runs failing, skipping cancelled ones, and reports the streak', () => {
    const findings = findFailingMain([
      run({ created_at: at(9), conclusion: 'failure' }),
      run({ created_at: at(8), conclusion: 'cancelled' }),
      run({ created_at: at(7), conclusion: 'failure' }),
      run({ created_at: at(6), conclusion: 'failure' }),
      run({ created_at: at(5), conclusion: 'success' }),
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].title, 'CI health (failing on main): Test');
    assert.equal(findings[0].evidence.length, 3);
  });

  it('stays quiet when the newest decided run passed or only one failed', () => {
    assert.deepEqual(findFailingMain([run({ created_at: at(9) }), run({ created_at: at(8), conclusion: 'failure' })]), []);
    assert.deepEqual(findFailingMain([run({ created_at: at(9), conclusion: 'failure' }), run({ created_at: at(8) })]), []);
    assert.deepEqual(findFailingMain([run({ conclusion: 'failure' })]), []);
  });
});

describe('slowdown detector', () => {
  const samples = (window, seconds, count, steps = ['Run npm run test:sidecar']) => Array.from({ length: count }, () => ({
    workflow: 'Test', job: 'sidecar', window, seconds, steps, run: run(),
  }));

  it('flags a median rise of at least 20% and 30 seconds', () => {
    const findings = findSlowdowns([...samples('current', 98, 6), ...samples('previous', 62, 6)]);
    assert.deepEqual(findings.map((finding) => finding.title), ['CI health (slower): Test / sidecar']);
    assert.match(findings[0].summary, /98s.*62s.*\+58%/);
    assert.doesNotMatch(findings[0].summary, /Steps new this week/);
  });

  it('names the steps that appeared this week, the usual cause of a deliberate slowdown', () => {
    const findings = findSlowdowns([
      ...samples('current', 98, 6, ['Run npm run test:sidecar', 'Test sidecar with the shipped Node.js runtime']),
      ...samples('previous', 62, 6),
    ]);
    assert.match(findings[0].summary, /Steps new this week: `Test sidecar with the shipped Node.js runtime`\./);
  });

  it('ignores small absolute rises, small relative rises, and thin samples', () => {
    assert.deepEqual(findSlowdowns([...samples('current', 30, 6), ...samples('previous', 20, 6)]), []);
    assert.deepEqual(findSlowdowns([...samples('current', 650, 6), ...samples('previous', 600, 6)]), []);
    assert.deepEqual(findSlowdowns([...samples('current', 98, SLOWDOWN.minSamples - 1), ...samples('previous', 62, 6)]), []);
  });
});

describe('issue sync', () => {
  const finding = { kind: 'flaky', title: 'CI health (flaky): Test / sidecar', summary: 'summary text', evidence: [{
    url: 'https://github.com/o/r/actions/runs/7', sha: '2fd501e11e', at: '2026-10-28T10:02:00Z', detail: 'failed on attempt 1, passed on attempt 2',
  }] };

  function fakeIssues(open) {
    const calls = [];
    return {
      calls,
      search: (title) => open.find((issue) => issue.title === title) ?? null,
      create: (title, body) => { calls.push(['create', title, body]); return { number: 99 }; },
      update: (number, body) => { calls.push(['update', number, body]); },
    };
  }

  it('updates the open issue with the same title instead of opening another', () => {
    const issues = fakeIssues([{ number: 12, title: finding.title }]);
    const actions = syncIssues({ findings: [finding], issues, generatedAt: '2026-11-02T06:30:00Z' });
    assert.deepEqual(actions, [{ action: 'updated', number: 12, title: finding.title }]);
    assert.equal(issues.calls[0][0], 'update');
    assert.match(issues.calls[0][2], /summary text/);
    assert.match(issues.calls[0][2], /\| 2026-10-28 10:02 \| `2fd501e11e` \| failed on attempt 1, passed on attempt 2 \| \[run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/7\) \|/);
    assert.match(issues.calls[0][2], /2026-11-02/);
  });

  it('opens an issue when no open one matches', () => {
    const issues = fakeIssues([]);
    assert.deepEqual(syncIssues({ findings: [finding], issues, generatedAt: '2026-11-02T06:30:00Z' }), [
      { action: 'created', number: 99, title: finding.title },
    ]);
  });

  it('only ever rewrites an issue the scan itself opened', () => {
    const title = finding.title;
    const human = { number: 3, title, user: { login: 'someone' } };
    const pull = { number: 4, title, user: { login: 'github-actions[bot]' }, pull_request: {} };
    const owned = { number: 5, title, user: { login: 'github-actions[bot]' } };
    assert.equal(pickOwnedIssue([human, pull], title), null);
    assert.equal(pickOwnedIssue([human, pull, owned], title), owned);
    assert.equal(pickOwnedIssue([{ ...owned, title: `${title} (copy)` }], title), null);
  });
});

describe('collection against a fake GitHub API', () => {
  // NOW is Saturday 12:00 UTC. The event window reaches back 7 days and 6 hours.
  function fakeGh({ daily = {}, attempts = {}, newestMain = [], staleMain = null, successMain = [] }) {
    const paths = [];
    let mainReads = 0;
    const gh = (args) => {
      assert.equal(args[0], 'api', 'a dry run must only read');
      const path = args[1];
      paths.push(path);
      const workflow = /workflows\/([^/]+)\/runs/.exec(path)?.[1];
      const date = /runs\?created=(\d{4}-\d{2}-\d{2})&/.exec(path)?.[1];
      if (date) return JSON.stringify({ workflow_runs: workflow === 'test.yml' ? (daily[date] ?? []) : [] });
      if (path.includes('runs?event=push&branch=main&per_page=')) {
        if (workflow !== 'test.yml') return JSON.stringify({ workflow_runs: [], total_count: 0 });
        mainReads += 1;
        if (staleMain && mainReads === 1) return JSON.stringify(staleMain);
        return JSON.stringify({ workflow_runs: newestMain, total_count: newestMain.length ? 500 : 0 });
      }
      if (path.includes('runs?event=push&branch=main&status=success')) return JSON.stringify({ workflow_runs: workflow === 'test.yml' ? successMain : [] });
      const attempt = /runs\/(\d+)\/attempts\/(\d+)\/jobs/.exec(path);
      if (attempt) return JSON.stringify({ jobs: attempts[`${attempt[1]}/${attempt[2]}`] ?? [] });
      throw new Error(`unexpected path ${path}`);
    };
    return { gh, paths };
  }

  it('reads every calendar day the overlapping window touches, so nothing falls between weekly scans', () => {
    const { gh, paths } = fakeGh({});
    checkCiHealth({ gh, repository: 'o/r', now: NOW, dryRun: true });
    for (const workflow of MONITORED_WORKFLOWS) {
      const days = paths.filter((path) => path.includes(`/workflows/${workflow}/runs?created=`)).map((path) => /created=([\d-]+)/.exec(path)[1]);
      assert.deepEqual(days, ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31']);
    }
  });

  it('inspects a re-run that still failed overall and reports the job it recovered', () => {
    const rerun = run({ id: 7, run_attempt: 2, conclusion: 'failure', event: 'pull_request', created_at: '2026-10-30T10:00:00Z' });
    const { gh } = fakeGh({
      daily: { '2026-10-30': [rerun] },
      attempts: {
        '7/1': [job('sidecar', 'failure', 40), job('unit-shard (2)', 'failure', 150)],
        '7/2': [job('sidecar', 'success'), job('unit-shard (2)', 'failure', 150)],
      },
    });
    const { findings, actions } = checkCiHealth({ gh, repository: 'o/r', now: NOW, dryRun: true });
    assert.deepEqual(findings.map((finding) => finding.title), ['CI health (flaky): Test / sidecar']);
    assert.deepEqual(actions, []);
  });

  it('keeps the newest re-runs when the per-workflow cap applies', () => {
    const attempts = {};
    const daily = {};
    // 61 re-runs: one on Oct 25 (oldest), sixty on Oct 31. Only the oldest flakes.
    daily['2026-10-25'] = [run({ id: 1000, run_attempt: 2, created_at: '2026-10-25T10:00:00Z' })];
    attempts['1000/1'] = [job('old', 'failure', 40)];
    attempts['1000/2'] = [job('old', 'success')];
    daily['2026-10-31'] = Array.from({ length: 60 }, (_, index) => {
      const id = 2000 + index;
      attempts[`${id}/1`] = [job('new', 'success')];
      attempts[`${id}/2`] = [job('new', 'success')];
      return run({ id, run_attempt: 2, created_at: `2026-10-31T0${Math.floor(index / 10)}:${String(index % 10).padStart(2, '0')}:00Z` });
    });
    daily['2026-10-31'][59] = { ...daily['2026-10-31'][59], id: 3000 };
    attempts['3000/1'] = [job('newest', 'failure', 40)];
    attempts['3000/2'] = [job('newest', 'success')];
    const { gh } = fakeGh({ daily, attempts });
    assert.deepEqual(checkCiHealth({ gh, repository: 'o/r', now: NOW, dryRun: true }).findings.map((finding) => finding.title), [
      'CI health (flaky): Test / newest',
    ]);
  });

  it('keeps a timeout from an earlier attempt that a later re-run turned green', () => {
    const rerun = run({ id: 9, run_attempt: 2, conclusion: 'success', event: 'push', head_branch: 'main', created_at: '2026-10-31T04:08:21Z' });
    const { gh } = fakeGh({
      daily: { '2026-10-31': [rerun] },
      attempts: { '9/1': [job('unit-shard (5)', 'cancelled', 916)], '9/2': [job('unit-shard (5)', 'success', 180)] },
    });
    const { findings } = checkCiHealth({ gh, repository: 'o/r', now: NOW, dryRun: true });
    const timeout = findings.find((finding) => finding.kind === 'timeout');
    assert.equal(timeout?.title, 'CI health (timeout): Test / unit-shard (5)');
    assert.match(timeout.evidence[0].detail, /attempt 1 cancelled after 916s/);
  });

  it('overlaps the previous scan by six hours and ignores anything older', () => {
    const attempts = { '11/1': [job('a', 'failure', 40)], '11/2': [job('a', 'success')], '12/1': [job('b', 'failure', 40)], '12/2': [job('b', 'success')] };
    // 7 days and 4 hours before NOW: the previous scan may have run late and missed it.
    const late = run({ id: 11, run_attempt: 2, created_at: '2026-10-24T08:00:00Z' });
    const old = run({ id: 12, run_attempt: 2, created_at: '2026-10-24T05:00:00Z' });
    const { gh } = fakeGh({ daily: { '2026-10-24': [late, old] }, attempts });
    assert.deepEqual(checkCiHealth({ gh, repository: 'o/r', now: NOW, dryRun: true }).findings.map((finding) => finding.title), [
      'CI health (flaky): Test / a',
    ]);
  });

  it('does not let a stale main listing raise a failing-main alarm', () => {
    const at = (hour, conclusion) => run({ id: hour, created_at: `2026-10-31T${String(hour).padStart(2, '0')}:00:00Z`, conclusion });
    const fresh = [at(11, 'success'), at(10, 'failure'), at(9, 'failure')];
    // The stale snapshot is an older view: a smaller total and only the failures.
    const stale = { workflow_runs: [at(10, 'failure'), at(9, 'failure')], total_count: 498 };
    const { gh } = fakeGh({ newestMain: fresh, staleMain: stale });
    assert.deepEqual(checkCiHealth({ gh, repository: 'o/r', now: NOW, dryRun: true }).findings, []);

    const { gh: failingGh } = fakeGh({ newestMain: [at(11, 'failure'), at(10, 'failure'), at(9, 'success')] });
    assert.deepEqual(checkCiHealth({ gh: failingGh, repository: 'o/r', now: NOW, dryRun: true }).findings.map((finding) => finding.title), [
      'CI health (failing on main): Test',
    ]);
  });
});

describe('ci-health-scan workflow', () => {
  const workflow = YAML.parse(readFileSync(resolve(import.meta.dirname, '../.github/workflows/ci-health-scan.yml'), 'utf8'));

  it('runs weekly and on demand, and never cancels a scan midway through issue updates', () => {
    assert.match(workflow.on.schedule[0].cron, /^\d+ \d+ \* \* \d$/);
    assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
    assert.deepEqual(workflow.concurrency, { group: 'ci-health-scan', 'cancel-in-progress': false });
  });

  it('grants only reads plus issue writes, and runs the scanner with the job token', () => {
    assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read', issues: 'write' });
    const step = workflow.jobs.scan.steps.find((item) => item.run?.includes('scripts/check-ci-health.mjs'));
    assert.ok(step);
    assert.equal(step.env.GH_TOKEN, '${{ github.token }}');
    for (const item of workflow.jobs.scan.steps.filter((entry) => entry.uses)) {
      assert.match(item.uses, /@[0-9a-f]{40}( |$)/, `${item.uses} must be pinned to a commit SHA`);
    }
  });
});
