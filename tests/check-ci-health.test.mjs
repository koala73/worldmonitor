import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import YAML from 'yaml';

import {
  MONITORED_WORKFLOWS,
  SLOWDOWN,
  attributeFlakes,
  checkCiHealth,
  findFailingMain,
  findFlakyJobs,
  findSlowdowns,
  findTimeouts,
  median,
  parseFailingTests,
  pickOwnedIssue,
  safeLabel,
  spreadSample,
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
    repository: { full_name: 'o/r' },
    head_repository: { full_name: 'o/r' },
    ...overrides,
  };
}

function job(name, conclusion, seconds = 120, startOffset = 0, steps = [], id = undefined) {
  const started = Date.parse('2026-10-31T04:10:00Z') + startOffset * 1000;
  return {
    id,
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

  it('says whether the flake came from main or a pull request, and keeps the failed job to read its log', () => {
    const [fromPr] = findFlakyJobs([{
      run: run({ run_attempt: 2, event: 'pull_request', pull_requests: [{ number: 9732 }] }),
      attempts: [[job('variant-smoke (2)', 'failure', 40, 0, [], 501)], [job('variant-smoke (2)', 'success', 120, 0, [], 502)]],
    }]);
    assert.equal(fromPr.evidence[0].detail, 'pull request: failed on attempt 1, passed on attempt 2');
    assert.deepEqual(fromPr.evidence[0].failedJobIds, [501]);
    assert.deepEqual(fromPr.evidence[0].pullRequests, [9732]);
    const [fromMain] = findFlakyJobs([{
      run: run({ run_attempt: 2, event: 'push', head_branch: 'main' }),
      attempts: [[job('sidecar', 'failure', 40)], [job('sidecar', 'success')]],
    }]);
    assert.match(fromMain.evidence[0].detail, /^main: /);
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

describe('slowdown sampling', () => {
  const at = (index) => run({ id: index, created_at: new Date(Date.parse('2026-10-26T00:00:00Z') + index * 3_600_000).toISOString() });

  it('spreads samples over the whole week instead of its newest day', () => {
    // 150 runs, one an hour; the newest 15 would all be from the last 15 hours.
    const runs = Array.from({ length: 150 }, (_, index) => at(index)).reverse();
    const picked = spreadSample(runs, 15).map((item) => item.id);
    assert.equal(picked.length, 15);
    assert.equal(picked[0], 0);
    assert.equal(picked.at(-1), 149);
    assert.ok(picked.every((id, index) => index === 0 || id - picked[index - 1] >= 10), picked.join(','));
  });

  it('keeps every run when there are no more than the sample size', () => {
    assert.deepEqual(spreadSample([at(3), at(1), at(2)], 15).map((item) => item.id), [1, 2, 3]);
    assert.deepEqual(spreadSample([at(1), at(2)], 1).map((item) => item.id), [2]);
    assert.deepEqual(spreadSample([], 15), []);
  });
});

describe('failing test names', () => {
  it('reads node:test, the file watchdog, Playwright and vitest failures from a job log', () => {
    // Lines as GitHub serves them in job logs (runs 40940954687, 41383834994).
    const log = [
      '2026-10-29T19:35:26.0058765Z ✖ failing tests:',
      '2026-10-29T19:35:26.0059019Z ',
      '2026-10-29T19:35:26.0059362Z test at tests/mcp-modern-era.test.mjs:965:5',
      '2026-10-29T19:35:26.0060605Z ✖ remaps a daily-quota -32029 to -31029 with the same 429, Retry-After and data (26.281888ms)',
      '2026-11-02T03:42:22.8530647Z Data test file still running after --file-timeout=300000ms (a test hung or a handle was left open): tests/runtime-config-panel-visibility.test.mjs',
      '2026-11-02T03:42:22.9073114Z test at tests/runtime-config-panel-visibility.test.mjs:1:1',
      '2026-11-02T03:37:55.6670668Z   1) [chromium] › e2e/dashboard-news-request-budget.spec.ts:474:3 › dashboard news request budget (#5376) › a degraded 200 digest',
      '2026-11-02T03:37:55.6670668Z  \u001b[31mFAIL\u001b[39m  tests/dom/panel-keyboard-resize-a11y.test.mts > keyboard resize',
      '2026-11-02T03:37:55.6670668Z   ✓  24 [chromium] › e2e/variant-live-smoke.spec.ts:83:3 › passes',
    ].join('\n');
    assert.deepEqual(parseFailingTests(log), [
      'tests/mcp-modern-era.test.mjs:965:5',
      'tests/runtime-config-panel-visibility.test.mjs:1:1',
      'e2e/dashboard-news-request-budget.spec.ts:474:3',
      'tests/dom/panel-keyboard-resize-a11y.test.mts',
    ]);
  });

  it('drops a test path long enough to push an issue body past GitHub\'s limit', () => {
    const long = `tests/${'a'.repeat(60_000)}.test.mjs:1:1`;
    assert.deepEqual(parseFailingTests(`test at ${long}\ntest at tests/ok.test.mjs:2:1`), ['tests/ok.test.mjs:2:1']);
  });

  it('accepts a test under any top-level directory of the repo', () => {
    const log = [
      'test at src-tauri/sidecar/local-api-server.test.mjs:12:3',
      'test at workers/relay/relay.test.mjs:4:1',
      ' FAIL  consumer-prices-core/src/parse.test.ts > sizes',
    ].join('\n');
    assert.deepEqual(parseFailingTests(log), [
      'src-tauri/sidecar/local-api-server.test.mjs:12:3',
      'workers/relay/relay.test.mjs:4:1',
      'consumer-prices-core/src/parse.test.ts',
    ]);
  });

  it('lets nothing but a plain repo test path out of a fork-controlled log', () => {
    const log = [
      'test at tests/../../etc/x.test.mjs:1:1',
      'test at .github/x.test.mjs',
      'test at /home/runner/tests/x.test.mjs',
      'test at tests/x.test.mjs:1:1|[evil](https://evil.example)',
      'test at ../../etc/passwd',
      'test at tests/@koala73.test.mjs',
      'test at https://evil.example/tests/a.test.mjs',
      'test at tests/not-a-test.mjs',
    ].join('\n');
    assert.deepEqual(parseFailingTests(log), []);
  });
});

describe('flake attribution', () => {
  const flake = (at, failedJobIds, title = 'CI health (flaky): Test / unit-shard (3)') => ({
    kind: 'flaky', title, summary: 's',
    evidence: [{ url: 'u', sha: 's', at, detail: 'pull request: failed on attempt 1, passed on attempt 2', failedJobIds: [failedJobIds].flat(), pullRequests: [9750], trustedLog: true }],
  });
  const logs = {
    1: 'test at tests/mcp-modern-era.test.mjs:965:5',
    2: '1) [chromium] › e2e/a.spec.ts:10:3 › t\ntest at tests/b.test.mjs:4:1',
    3: 'no failing test named here',
  };
  const readLog = (id) => {
    if (!(id in logs)) throw new Error('HTTP 410: logs expired');
    return logs[id];
  };

  it('names the failing tests and drops a flake whose test changed on main since it failed', () => {
    // #10016: the Retry-After flake on Oct 29; #9863 froze the clock on Oct 30.
    const calls = [];
    const changeSince = (file, iso, pullRequests) => {
      calls.push([file, iso, pullRequests]);
      return file === 'tests/mcp-modern-era.test.mjs' ? '083a1800f0' : null;
    };
    const { findings, skipped } = attributeFlakes([flake('2026-10-29T19:32:00Z', 1)], { readLog, changeSince });
    assert.deepEqual(findings, []);
    assert.deepEqual(skipped, ['CI health (flaky): Test / unit-shard (3)']);
    assert.deepEqual(calls, [['tests/mcp-modern-era.test.mjs', '2026-10-29T19:32:00Z', [9750]]]);
  });

  it('keeps a flake until every test it named has changed, and shows which did', () => {
    const changeSince = (file) => (file === 'e2e/a.spec.ts' ? 'abc1234567' : null);
    const { findings, skipped } = attributeFlakes([flake('2026-10-30T00:00:00Z', 2)], { readLog, changeSince });
    assert.deepEqual(skipped, []);
    assert.equal(findings[0].evidence[0].detail,
      'pull request: failed on attempt 1, passed on attempt 2 · failing: `e2e/a.spec.ts:10:3`, `tests/b.test.mjs:4:1`');
  });

  it('keeps a flake when any occurrence is not shown to be addressed', () => {
    const finding = flake('2026-10-29T19:32:00Z', 1);
    finding.evidence.push({ ...finding.evidence[0], at: '2026-11-01T00:00:00Z', failedJobIds: [3] });
    const { findings, warnings } = attributeFlakes([finding, flake('2026-10-31T00:00:00Z', 99, 'CI health (flaky): Test / sidecar')], {
      readLog, changeSince: () => '083a1800f0',
    });
    assert.deepEqual(findings.map((item) => item.title), ['CI health (flaky): Test / unit-shard (3)', 'CI health (flaky): Test / sidecar']);
    assert.match(findings[0].evidence[0].detail, /changed on main since: `083a1800f0`/);
    assert.doesNotMatch(findings[0].evidence[1].detail, /failing:/);
    assert.deepEqual(warnings, ['log for job 99 unreadable: HTTP 410_ logs expired']);
  });

  it('keeps a flake and warns, instead of failing the scan, when file history is unreadable', () => {
    const { findings, warnings } = attributeFlakes([flake('2026-10-29T19:32:00Z', 1)], {
      readLog, changeSince: () => { throw new Error('HTTP 502'); },
    });
    assert.equal(findings.length, 1);
    assert.deepEqual(warnings, ['history of tests/mcp-modern-era.test.mjs unreadable: HTTP 502']);
  });

  it('reads at most the newest flakes per scan and leaves other kinds alone', () => {
    const read = [];
    const timeout = { kind: 'timeout', title: 't', summary: 's', evidence: [{ at: '2026-10-31T00:00:00Z', failedJobIds: [1] }] };
    const flakes = [flake('2026-10-28T00:00:00Z', 1, 'a'), flake('2026-10-30T00:00:00Z', 1, 'b'), flake('2026-10-29T00:00:00Z', 1, 'c')];
    const { findings } = attributeFlakes([timeout, ...flakes], {
      readLog: (id) => { read.push(id); return logs[id]; }, changeSince: () => 'x', limit: 2,
    });
    assert.equal(read.length, 2);
    assert.deepEqual(findings.map((item) => item.title), ['t', 'a']);
  });

  it('decides on every failing file, not only the five it shows', () => {
    const many = Array.from({ length: 6 }, (_, index) => `test at tests/f${index}.test.mjs:1:1`).join('\n');
    const { findings, skipped } = attributeFlakes([flake('2026-10-29T00:00:00Z', 7)], {
      readLog: () => many, changeSince: (file) => (file === 'tests/f5.test.mjs' ? null : 'abc'),
    });
    assert.deepEqual(skipped, []);
    assert.match(findings[0].evidence[0].detail, /`tests\/f4\.test\.mjs:1:1` and 1 more$/);
  });

  it('keeps a flake when a later failed attempt names a test that has not changed', () => {
    // Failed on attempts 1 and 2 in different tests, passed on attempt 3.
    const [finding] = findFlakyJobs([{
      run: run({ run_attempt: 3, event: 'pull_request' }),
      attempts: [
        [job('unit-shard (1)', 'failure', 150, 0, [], 1)],
        [job('unit-shard (1)', 'failure', 150, 0, [], 2)],
        [job('unit-shard (1)', 'success', 150, 0, [], 3)],
      ],
    }]);
    assert.deepEqual(finding.evidence[0].failedJobIds, [1, 2]);
    const { findings, skipped } = attributeFlakes([finding], {
      readLog, changeSince: (file) => (file === 'tests/mcp-modern-era.test.mjs' ? 'fixed' : null),
    });
    assert.deepEqual(skipped, []);
    assert.match(findings[0].evidence[0].detail, /`tests\/mcp-modern-era\.test\.mjs:965:5`, `e2e\/a\.spec\.ts:10:3`, `tests\/b\.test\.mjs:4:1`/);
  });

  it('keeps a flake when any failed attempt names no test', () => {
    const { skipped } = attributeFlakes([flake('2026-10-29T00:00:00Z', [1, 3])], { readLog, changeSince: () => 'fixed' });
    assert.deepEqual(skipped, []);
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

  it('keeps syncing the remaining findings when GitHub rejects one write', () => {
    const issues = fakeIssues([{ number: 12, title: finding.title }]);
    issues.update = () => { throw new Error('HTTP 422: body is too long'); };
    const second = { ...finding, title: 'CI health (slower): Test / sidecar' };
    assert.deepEqual(syncIssues({ findings: [finding, second], issues, generatedAt: '2026-11-02T06:30:00Z' }), [
      { action: 'failed', number: null, title: finding.title, error: 'HTTP 422_ body is too long' },
      { action: 'created', number: 99, title: second.title },
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
  function fakeGh({ daily = {}, attempts = {}, newestMain = [], staleMain = null, successMain = [], logs = {}, commits = {}, pulls = {} }) {
    const paths = [];
    let mainReads = 0;
    const gh = (args) => {
      assert.equal(args[0], 'api', 'a dry run must only read');
      const path = args.at(-1);
      paths.push(path);
      const log = /^repos\/o\/r\/actions\/jobs\/(\d+)\/logs$/.exec(path);
      if (log) {
        assert.ok(args.includes('--allow-escape-sequences'), 'gh refuses a log with colour codes without the flag');
        return logs[log[1]];
      }
      const history = /^repos\/o\/r\/commits\?sha=main&path=([^&]+)&since=([^&]+)&per_page=20$/.exec(path);
      if (history) return JSON.stringify(commits[decodeURIComponent(history[1])] ?? []);
      const association = /^repos\/o\/r\/commits\/(\w+)\/pulls$/.exec(path);
      if (association) return JSON.stringify((pulls[association[1]] ?? []).map((number) => ({ number })));
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

  it('never lets a fork\'s own job log decide that its flake was fixed', () => {
    const file = 'tests/mcp-modern-era.test.mjs';
    const scan = (overrides) => {
      const rerun = run({ id: 7, run_attempt: 2, event: 'pull_request', created_at: '2026-10-29T19:32:00Z', ...overrides });
      const { gh } = fakeGh({
        daily: { '2026-10-29': [rerun] },
        attempts: { '7/1': [job('unit-shard (3)', 'failure', 150, 0, [], 41)], '7/2': [job('unit-shard (3)', 'success', 150, 0, [], 42)] },
        // The fork prints a recently changed test it never ran.
        logs: { 41: `test at ${file}:1:1\n` },
        commits: { [file]: [{ sha: '083a1800f0ffffff', commit: { message: 'test(mcp): freeze the clock (#9863)' } }] },
      });
      return checkCiHealth({ gh, repository: 'o/r', now: NOW, dryRun: true });
    };
    for (const provenance of [
      { head_repository: { full_name: 'contributor/r' } },
      { head_repository: null },
      { repository: undefined },
    ]) {
      const result = scan(provenance);
      assert.deepEqual(result.skipped, [], JSON.stringify(provenance));
      assert.match(result.findings[0].evidence[0].detail, /failing: `tests\/mcp-modern-era\.test\.mjs:1:1`$/);
    }
    assert.deepEqual(scan({}).skipped, ['CI health (flaky): Test / unit-shard (3)']);
  });

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

  it('reads the failed attempt log and does not count the flaking PR\'s own merge as a fix', () => {
    const rerun = run({ id: 7, run_attempt: 2, event: 'pull_request', pull_requests: [{ number: 9750 }], created_at: '2026-10-29T19:32:00Z' });
    const file = 'tests/mcp-modern-era.test.mjs';
    const merge = { sha: 'aaaaaaaaaaaaaaaa', commit: { message: 'feat(ukmto): hormuz source (#9750)\n\nbody' } };
    const fix = { sha: '083a1800f0ffffff', commit: { message: 'test(mcp): freeze the clock (#9863)' } };
    const setup = (history) => fakeGh({
      daily: { '2026-10-29': [rerun] },
      attempts: { '7/1': [job('unit-shard (3)', 'failure', 150, 0, [], 41)], '7/2': [job('unit-shard (3)', 'success', 150, 0, [], 42)] },
      logs: { 41: '2026-10-29T19:35:26.0059362Z test at tests/mcp-modern-era.test.mjs:965:5\n' },
      commits: { [file]: history },
    });

    const { gh: onlyOwnMerge } = setup([merge]);
    const kept = checkCiHealth({ gh: onlyOwnMerge, repository: 'o/r', now: NOW, dryRun: true });
    assert.deepEqual(kept.findings.map((finding) => finding.title), ['CI health (flaky): Test / unit-shard (3)']);
    assert.match(kept.findings[0].evidence[0].detail, /failing: `tests\/mcp-modern-era\.test\.mjs:965:5`$/);

    // The API lists newest first; the first change after the flake is the oldest.
    const { gh: fixed, paths } = setup([fix, merge]);
    const result = checkCiHealth({ gh: fixed, repository: 'o/r', now: NOW, dryRun: true });
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.skipped, ['CI health (flaky): Test / unit-shard (3)']);
    assert.ok(paths.includes('repos/o/r/commits?sha=main&path=tests%2Fmcp-modern-era.test.mjs&since=2026-10-29T19%3A32%3A00Z&per_page=20'));
  });

  it('asks GitHub which pull request a later commit belongs to, since a merge subject may lack (#N)', () => {
    const rerun = run({ id: 7, run_attempt: 2, event: 'pull_request', pull_requests: [{ number: 9750 }], created_at: '2026-10-29T19:32:00Z' });
    const file = 'tests/mcp-modern-era.test.mjs';
    const merge = { sha: 'aaaaaaaaaaaaaaaa', commit: { message: 'Merge branch feat/ukmto-hormuz-source' } };
    const fix = { sha: 'bbbbbbbbbbbbbbbb', commit: { message: 'test(mcp): freeze the clock' } };
    const setup = (history, pulls) => fakeGh({
      daily: { '2026-10-29': [rerun] },
      attempts: { '7/1': [job('unit-shard (3)', 'failure', 150, 0, [], 41)], '7/2': [job('unit-shard (3)', 'success', 150, 0, [], 42)] },
      logs: { 41: 'test at tests/mcp-modern-era.test.mjs:965:5\n' },
      commits: { [file]: history },
      pulls,
    });
    const scan = (gh) => checkCiHealth({ gh, repository: 'o/r', now: NOW, dryRun: true });

    // Only the flaking PR's own merge changed the file: still reported.
    assert.equal(scan(setup([merge], { aaaaaaaaaaaaaaaa: [9750] }).gh).findings.length, 1);
    // A later fix from another PR: skipped, and the fix is the one cited.
    const fixed = scan(setup([fix, merge], { aaaaaaaaaaaaaaaa: [9750], bbbbbbbbbbbbbbbb: [9863] }).gh);
    assert.deepEqual(fixed.skipped, ['CI health (flaky): Test / unit-shard (3)']);
    // More own-PR commits than the lookup budget: unresolved, so still reported.
    const own = Array.from({ length: 4 }, (_, index) => ({ sha: `c${index}`.padEnd(16, '0'), commit: { message: 'wip' } }));
    const busy = scan(setup([fix, ...own], Object.fromEntries(own.map((commit) => [commit.sha, [9750]]))).gh);
    assert.equal(busy.findings.length, 1);
  });

  it('samples slowdown runs across each whole week, not its newest day', () => {
    // 40 successful main runs a week, newest first as the API lists them.
    const successMain = Array.from({ length: 80 }, (_, index) => run({
      id: 5000 + index, created_at: new Date(NOW - (index + 0.5) * 4.2 * 3_600_000).toISOString(),
    }));
    const { gh, paths } = fakeGh({ successMain });
    checkCiHealth({ gh, repository: 'o/r', now: NOW, dryRun: true });
    // A finding links the first sample read, which must be the newest run.
    assert.equal(paths.find((path) => path.includes('/attempts/1/jobs')), 'repos/o/r/actions/runs/5000/attempts/1/jobs?per_page=100');
    const read = paths.map((path) => /runs\/(\d+)\/attempts\/1\/jobs/.exec(path)?.[1]).filter(Boolean).map(Number);
    const ages = read.map((id) => (NOW - Date.parse(successMain[id - 5000].created_at)) / 86_400_000);
    const current = ages.filter((age) => age < 7);
    const previous = ages.filter((age) => age >= 7);
    assert.equal(current.length, SLOWDOWN.samplesPerWindow);
    assert.equal(previous.length, SLOWDOWN.samplesPerWindow);
    assert.ok(Math.min(...current) < 1 && Math.max(...current) > 6, `current week spans ${current.join(',')}`);
    assert.ok(Math.min(...previous) < 8 && Math.max(...previous) > 13, `previous week spans ${previous.join(',')}`);
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
