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

function job(name, conclusion, seconds = 120) {
  const started = Date.parse('2026-10-31T04:10:00Z');
  return {
    name,
    conclusion,
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
        [job('unit-shard (3)', 'failure', 180), job('unit', 'failure', 3)],
        [job('unit-shard (3)', 'success'), job('unit', 'success', 3)],
      ],
    }]);
    assert.deepEqual(findings.map((finding) => finding.title), ['CI health (flaky): Test / unit-shard (3)']);
  });

  it('still flags a fast job that failed on its own', () => {
    const findings = findFlakyJobs([{
      run: run({ run_attempt: 2 }),
      attempts: [[job('changes', 'failure', 4)], [job('changes', 'success', 4)]],
    }]);
    assert.equal(findings.length, 1);
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
    const findings = findTimeouts([{ run: run({ conclusion: 'cancelled' }), jobs: [
      job('unit-shard (5)', 'cancelled', 916),
      job('unit-shard (1)', 'cancelled', 120),
      job('unit', 'failure', 3),
    ] }]);
    assert.deepEqual(findings.map((finding) => finding.title), ['CI health (timeout): Test / unit-shard (5)']);
    assert.match(findings[0].evidence[0].detail, /916s/);
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
  const samples = (window, seconds, count) => Array.from({ length: count }, () => ({
    workflow: 'Test', job: 'sidecar', window, seconds, run: run(),
  }));

  it('flags a median rise of at least 20% and 30 seconds', () => {
    const findings = findSlowdowns([...samples('current', 98, 6), ...samples('previous', 62, 6)]);
    assert.deepEqual(findings.map((finding) => finding.title), ['CI health (slower): Test / sidecar']);
    assert.match(findings[0].summary, /98s.*62s.*\+58%/);
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
});

describe('collection against a fake GitHub API', () => {
  it('reads each monitored workflow one day at a time and every attempt of a re-run', () => {
    const paths = [];
    const rerun = run({ id: 7, run_attempt: 2, created_at: '2026-10-30T10:00:00Z' });
    const gh = (args) => {
      assert.equal(args[0], 'api', 'a dry run must only read');
      const path = args[1];
      paths.push(path);
      if (path.includes('/runs?created=2026-10-30&')) return JSON.stringify({ workflow_runs: path.includes('test.yml') ? [rerun] : [] });
      if (path.includes('/runs?')) return JSON.stringify({ workflow_runs: [] });
      if (path.endsWith('/runs/7/attempts/1/jobs?per_page=100')) return JSON.stringify({ jobs: [job('sidecar', 'failure', 40)] });
      if (path.endsWith('/runs/7/attempts/2/jobs?per_page=100')) return JSON.stringify({ jobs: [job('sidecar', 'success')] });
      throw new Error(`unexpected path ${path}`);
    };
    const { findings, actions } = checkCiHealth({ gh, repository: 'o/r', now: NOW, dryRun: true });
    assert.deepEqual(findings.map((finding) => finding.title), ['CI health (flaky): Test / sidecar']);
    assert.deepEqual(actions, []);
    for (const workflow of MONITORED_WORKFLOWS) {
      const days = paths.filter((path) => path.includes(`/workflows/${workflow}/runs?created=2026-`)).map((path) => /created=(\d{4}-\d{2}-\d{2})/.exec(path)[1]);
      assert.deepEqual(days, ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31']);
    }
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
