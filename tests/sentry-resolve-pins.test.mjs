import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import {
  assertLiveBoardIsNotEmpty,
  auditResolvedIssues,
  classifyResolution,
  fetchResolvedIssues,
  formatReport,
  parseArguments,
  parseLinkHeader,
} from '../scripts/audit-sentry-resolve-pins.mjs';

const auditScript = fileURLToPath(
  new URL('../scripts/audit-sentry-resolve-pins.mjs', import.meta.url),
);
const workflowSource = readFileSync(
  new URL('../.github/workflows/sentry-resolve-pin-audit.yml', import.meta.url),
  'utf8',
);
const workflow = YAML.parse(workflowSource);

const RESOLVER_EMAIL = 'resolver@worldmonitor.app';

// The `actor` block Sentry attaches to a pinned resolution. It is the reason
// the report is built from named fields rather than from statusDetails.
const ACTOR = Object.freeze({
  id: '3141592',
  name: 'Elie Habib',
  username: RESOLVER_EMAIL,
  email: RESOLVER_EMAIL,
  avatarUrl: 'https://secure.gravatar.com/avatar/deadbeefdeadbeefdeadbeefdeadbeef',
  lastLogin: '2026-09-06T08:12:44.000Z',
  dateJoined: '2024-02-11T19:03:02.000Z',
});

function issue(overrides = {}) {
  const shortId = overrides.shortId ?? 'WORLDMONITOR-AA';
  return {
    id: '7000000001',
    shortId,
    status: 'resolved',
    statusDetails: {},
    permalink: `https://elie-habib.sentry.io/issues/?query=${shortId}`,
    ...overrides,
  };
}

function runAuditCliRaw(contents) {
  const directory = mkdtempSync(join(tmpdir(), 'wm-sentry-resolve-pins-'));
  const inputPath = join(directory, 'issues.json');
  try {
    writeFileSync(inputPath, contents);
    return spawnSync(process.execPath, [auditScript, '--input', inputPath], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runAuditCli(issues) {
  return runAuditCliRaw(JSON.stringify(issues));
}

function pageResponse({ body, link = null, status = 200, statusText = 'OK' }) {
  return {
    status,
    statusText,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (name.toLowerCase() === 'link' ? link : null) },
    json: async () => body,
  };
}

function nextLink(url, results) {
  return `<${url}>; rel="previous"; results="false"; cursor="0:0:1", `
    + `<${url}>; rel="next"; results="${results}"; cursor="0:100:0"`;
}

function scriptedFetch(pages) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const page = pages[calls.length - 1];
    if (!page) throw new Error(`unexpected fetch beyond the script: ${url}`);
    return page;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const CURSOR_2 = 'https://us.sentry.io/api/0/projects/elie-habib/worldmonitor/issues/?cursor=0:100:0';
const CURSOR_3 = 'https://us.sentry.io/api/0/projects/elie-habib/worldmonitor/issues/?cursor=0:200:0';

const REAL_VIOLATIONS = [
  issue({
    id: '7100000122',
    shortId: 'WORLDMONITOR-122',
    statusDetails: {
      inRelease: '73e53ba5f7ccc60e87d62a50b737c312310f48eb',
      actor: { ...ACTOR },
    },
  }),
  issue({
    id: '710000011X',
    shortId: 'WORLDMONITOR-11X',
    statusDetails: {
      inRelease: '73e53ba5f7ccc60e87d62a50b737c312310f48eb',
      actor: { ...ACTOR },
    },
  }),
  issue({
    id: '710000011Y',
    shortId: 'WORLDMONITOR-11Y',
    statusDetails: {
      inRelease: '3592404afcf321cf5e96fd198541fa338477fe87',
      actor: { ...ACTOR },
    },
  }),
  issue({
    id: '710000011Z',
    shortId: 'WORLDMONITOR-11Z',
    statusDetails: {
      inCommit: { id: 'c0ffee1234567890', author: { ...ACTOR }, repository: { name: 'koala73/worldmonitor' } },
      actor: { ...ACTOR },
    },
  }),
];

describe('Sentry resolve-pin audit', () => {
  it('classifies each pin kind off its status-details key', () => {
    assert.deepEqual(
      classifyResolution(issue({ statusDetails: { inRelease: 'abc123' } })),
      { kind: 'in-release', pinKey: 'inRelease', pinValue: 'release abc123' },
    );
    assert.deepEqual(
      classifyResolution(issue({ statusDetails: { inNextRelease: true } })),
      { kind: 'in-next-release', pinKey: 'inNextRelease', pinValue: 'the next release' },
    );
    assert.deepEqual(
      classifyResolution(issue({ statusDetails: { inCommit: { id: 'deadbeef', author: ACTOR } } })),
      { kind: 'in-commit', pinKey: 'inCommit', pinValue: 'commit deadbeef' },
    );
  });

  it('treats an empty status-details object as a plain resolve', () => {
    assert.deepEqual(
      classifyResolution(issue({ statusDetails: {} })),
      { kind: 'plain', pinKey: null, pinValue: null },
    );
    assert.deepEqual(
      classifyResolution(issue({ statusDetails: undefined })),
      { kind: 'plain', pinKey: null, pinValue: null },
    );
  });

  it('treats status details carrying only an actor as a plain resolve', () => {
    // Emptiness is not the discriminator. If Sentry ever attached `actor` to
    // plain resolves as well, an emptiness test would turn every clean row on
    // the board into a violation.
    assert.deepEqual(
      classifyResolution(issue({ statusDetails: { actor: { ...ACTOR } } })),
      { kind: 'plain', pinKey: null, pinValue: null },
    );
    const result = auditResolvedIssues([issue({ statusDetails: { actor: { ...ACTOR } } })]);
    assert.equal(result.checked, 1);
    assert.deepEqual(result.violations, []);
  });

  it('skips an archived issue whose status details hold an ignore window', () => {
    const result = auditResolvedIssues([
      issue({
        shortId: 'WORLDMONITOR-ZZ',
        status: 'ignored',
        statusDetails: { ignoreCount: 100, ignoreWindow: 60 },
      }),
      issue({ shortId: 'WORLDMONITOR-BB' }),
    ]);

    assert.equal(result.checked, 1);
    assert.equal(result.skippedNonResolved, 1);
    assert.deepEqual(result.violations, []);
  });

  it('follows rel=next only while the page reports more results', () => {
    const more = '<https://us.sentry.io/api/0/projects/elie-habib/worldmonitor/issues/'
      + '?per_page=2&cursor=2:-1:1>; rel="previous"; results="false"; cursor="2:-1:1", '
      + '<https://us.sentry.io/api/0/projects/elie-habib/worldmonitor/issues/'
      + '?cursor=2:1:0>; rel="next"; results="true"; cursor="2:1:0"';
    assert.deepEqual(parseLinkHeader(more), {
      next: 'https://us.sentry.io/api/0/projects/elie-habib/worldmonitor/issues/?cursor=2:1:0',
    });

    const last = '<https://us.sentry.io/api/0/projects/elie-habib/worldmonitor/issues/'
      + '?per_page=2&cursor=2:-1:1>; rel="previous"; results="true"; cursor="2:-1:1", '
      + '<https://us.sentry.io/api/0/projects/elie-habib/worldmonitor/issues/'
      + '?cursor=2:1:0>; rel="next"; results="false"; cursor="2:1:0"';
    assert.deepEqual(parseLinkHeader(last), { next: null });
    assert.deepEqual(parseLinkHeader(''), { next: null });
    assert.deepEqual(parseLinkHeader(null), { next: null });

    // Entries are split on the comma that opens the next <URI>, so a comma
    // inside a query value cannot truncate the cursor.
    const commaInQuery = '<https://us.sentry.io/api/0/issues/?query=is%3Aresolved,is%3Aunassigned'
      + '&cursor=1:0:0>; rel="next"; results="true"; cursor="1:0:0"';
    assert.deepEqual(parseLinkHeader(commaInQuery), {
      next: 'https://us.sentry.io/api/0/issues/?query=is%3Aresolved,is%3Aunassigned&cursor=1:0:0',
    });
    assert.deepEqual(
      parseLinkHeader('<https://us.sentry.io/x>; rel="previous"; results="true"; cursor="0:0:1"'),
      { next: null },
    );
  });

  it('parses only the documented input option', () => {
    assert.deepEqual({ ...parseArguments(['--input', 'issues.json']) }, { input: 'issues.json' });
    assert.throws(() => parseArguments(['--fix']), /Unknown option/);
  });

  it('fails the audit and names every pinned issue on the real board', () => {
    const run = runAuditCli([
      ...REAL_VIOLATIONS,
      issue({ shortId: 'WORLDMONITOR-CC' }),
      issue({ shortId: 'WORLDMONITOR-DD' }),
    ]);

    assert.equal(run.status, 1, run.stderr);
    for (const shortId of ['WORLDMONITOR-122', 'WORLDMONITOR-11X', 'WORLDMONITOR-11Y', 'WORLDMONITOR-11Z']) {
      assert.match(run.stdout, new RegExp(shortId, 'u'));
      assert.match(run.stderr, new RegExp(`::error::${shortId}`, 'u'));
    }
    assert.match(run.stdout, /4 of 6/u);
    assert.match(run.stderr, /PUT status=unresolved/u);
    assert.match(run.stderr, /silently no-ops/u);
    assert.match(run.stderr, /Only repair a confirmed incompatible pin/u);
    assert.doesNotMatch(`${run.stdout}${run.stderr}`, /can never reopen/u);
  });

  it('never prints the resolver identity Sentry attaches to a pin', () => {
    const run = runAuditCli(REAL_VIOLATIONS);
    const output = `${run.stdout}${run.stderr}`;

    for (const field of Object.values(ACTOR)) {
      assert.doesNotMatch(output, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    }
    for (const key of ['avatarUrl', 'gravatar', 'lastLogin', 'dateJoined', 'username', 'actor']) {
      assert.doesNotMatch(output, new RegExp(key, 'u'));
    }
    assert.match(output, /commit c0ffee1234567890/u, 'the commit pin must still be named');
    assert.equal(
      formatReport(auditResolvedIssues(REAL_VIOLATIONS)).includes(RESOLVER_EMAIL),
      false,
    );
  });

  it('passes a board of plain resolves', () => {
    const run = runAuditCli([
      issue({ shortId: 'WORLDMONITOR-CC' }),
      issue({ shortId: 'WORLDMONITOR-DD', statusDetails: {} }),
    ]);

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Sentry resolve pins clean: 2 resolved issues/u);
    assert.equal(run.stderr, '');
  });

  it('refuses to call an empty live read a clean board', () => {
    // A wrong org or project, or a token that cannot see the project, returns
    // an empty list. Passing on that makes the broken state look like the
    // healthy one.
    assert.throws(
      () => assertLiveBoardIsNotEmpty([], 'elie-habib', 'worldmonitor'),
      /no resolved issues for elie-habib\/worldmonitor/u,
    );
    assert.throws(() => assertLiveBoardIsNotEmpty(null, 'org', 'project'), /no resolved issues/u);
    assert.doesNotThrow(() => assertLiveBoardIsNotEmpty([issue()], 'org', 'project'));
  });

  it('walks every page and asks for the unbounded, resolved-only listing', async () => {
    const fetchImpl = scriptedFetch([
      pageResponse({ body: [issue({ shortId: 'A' }), issue({ shortId: 'B' })], link: nextLink(CURSOR_2, 'true') }),
      pageResponse({ body: [issue({ shortId: 'C' }), issue({ shortId: 'D' })], link: nextLink(CURSOR_3, 'true') }),
      pageResponse({ body: [issue({ shortId: 'E' })], link: nextLink(CURSOR_3, 'false') }),
    ]);

    const issues = await fetchResolvedIssues('sntryu_token', 'elie-habib', 'worldmonitor', fetchImpl);

    assert.deepEqual(issues.map((row) => row.shortId), ['A', 'B', 'C', 'D', 'E']);
    assert.deepEqual(fetchImpl.calls.map((call) => call.url), [
      'https://us.sentry.io/api/0/projects/elie-habib/worldmonitor/issues/'
        + '?query=is%3Aresolved&limit=100&statsPeriod=',
      CURSOR_2,
      CURSOR_3,
    ]);
    assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer sntryu_token');
    assert.ok(fetchImpl.calls[0].init.signal, 'every request must carry a timeout signal');
  });

  it('stops at the page cap instead of looping on a cursor that never ends', async () => {
    const fetchImpl = scriptedFetch(
      Array.from({ length: 60 }, () => pageResponse({ body: [issue()], link: nextLink(CURSOR_2, 'true') })),
    );

    await assert.rejects(
      () => fetchResolvedIssues('sntryu_token', 'elie-habib', 'worldmonitor', fetchImpl),
      /pagination exceeded 50 pages/u,
    );
    assert.equal(fetchImpl.calls.length, 50);
  });

  it('refuses to send the token to a host the cursor redirected to', async () => {
    const fetchImpl = scriptedFetch([
      pageResponse({ body: [issue()], link: nextLink('https://evil.example/api/0/issues/', 'true') }),
    ]);

    await assert.rejects(
      () => fetchResolvedIssues('sntryu_token', 'elie-habib', 'worldmonitor', fetchImpl),
      /cursor left https:\/\/us\.sentry\.io/u,
    );
    assert.equal(fetchImpl.calls.length, 1, 'the foreign host must never be requested');
  });

  it('names the release-token trap on a 403 and fails plainly on other statuses', async () => {
    await assert.rejects(
      () => fetchResolvedIssues('sntrys_upload', 'elie-habib', 'worldmonitor', scriptedFetch([
        pageResponse({ body: { detail: 'forbidden' }, status: 403, statusText: 'Forbidden' }),
      ])),
      /release-scoped `sntrys_` upload token cannot read issues[\s\S]*event:read/u,
    );
    await assert.rejects(
      () => fetchResolvedIssues('sntryu_token', 'elie-habib', 'nope', scriptedFetch([
        pageResponse({ body: { detail: 'missing' }, status: 404, statusText: 'Not Found' }),
      ])),
      /HTTP 404 Not Found/u,
    );
  });

  it('rejects a live read that is an error object or an empty board', async () => {
    await assert.rejects(
      () => fetchResolvedIssues('sntryu_token', 'elie-habib', 'worldmonitor', scriptedFetch([
        pageResponse({ body: { detail: 'Authentication credentials were not provided.' } }),
      ])),
      /response was not an array/u,
    );
    await assert.rejects(
      () => fetchResolvedIssues('sntryu_token', 'elie-habib', 'worldmonitor', scriptedFetch([
        pageResponse({ body: [], link: nextLink(CURSOR_2, 'false') }),
      ])),
      /no resolved issues for elie-habib\/worldmonitor/u,
    );
  });

  it('exits non-zero when the audit itself fails instead of reporting a clean board', () => {
    const notArray = runAuditCliRaw('{"detail":"Authentication credentials were not provided."}');
    assert.equal(notArray.status, 1);
    assert.match(notArray.stderr, /Expected an array of Sentry issues/u);
    assert.doesNotMatch(notArray.stdout, /clean/u);

    const malformed = runAuditCliRaw('{ not json');
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /Sentry resolve-pin audit failed:/u);

    const missing = spawnSync(
      process.execPath,
      [auditScript, '--input', join(tmpdir(), 'wm-sentry-resolve-pins-absent.json')],
      { encoding: 'utf8' },
    );
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Sentry resolve-pin audit failed:/u);
  });

  it('wires the scheduled audit to the script and the read token', () => {
    assert.match(workflowSource, /audit-sentry-resolve-pins\.mjs/u);

    const steps = workflow.jobs.audit.steps;
    const auditStep = steps.find((step) => (step.run ?? '').includes('audit-sentry-resolve-pins.mjs'));
    assert.ok(auditStep, 'the workflow must run the audit script');
    assert.equal(auditStep.env.SENTRY_AUTH_TOKEN, '${{ secrets.SENTRY_AUTH_TOKEN }}');

    // A backstop that skips itself when the credential is absent reproduces
    // the silent-success failure this audit exists to catch.
    const guardStep = steps.find((step) => (step.run ?? '').includes('::error::SENTRY_AUTH_TOKEN'));
    assert.ok(guardStep, 'a missing secret must fail loudly rather than skip');
    assert.match(guardStep.run, /exit 1/u);
    assert.ok(
      steps.indexOf(guardStep) < steps.indexOf(auditStep),
      'the guard must run before the audit or the audit reports the failure first',
    );

    assert.ok(workflow.on.schedule?.length >= 1, 'the audit must run on a schedule');
    assert.ok('workflow_dispatch' in workflow.on);
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.deepEqual(workflow.concurrency, {
      group: 'sentry-resolve-pin-audit-${{ github.ref }}',
      'cancel-in-progress': true,
    });
    for (const step of steps) {
      if (!step.uses) continue;
      assert.match(step.uses, /@[0-9a-f]{40}$/u, `${step.uses} must be pinned to a commit SHA`);
    }
  });
});
