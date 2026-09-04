import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(repoRoot, '.github/workflows/deploy-gate.yml');
const workflow = YAML.parse(readFileSync(workflowPath, 'utf8'));
const gateStep = workflow.jobs.gate.steps.find(
  (step) => step.name === 'Check required PR gates passed for this SHA',
);
const SHA = 'fedcba9876543210fedcba9876543210fedcba98';

// The whole required list, read from the workflow so the test cannot pass by
// pinning a shorter list than production actually gates on.
const REQUIRED_LITERAL = gateStep.run.match(/required='(\[[^']*\])'/)[1];
const REQUIRED = JSON.parse(REQUIRED_LITERAL);
const GATE_STAMP = `[gate-contract:${createHash('sha256').update(REQUIRED_LITERAL).digest('hex').slice(0, 12)}]`;
const stamped = (description) => `${description} ${GATE_STAMP}`;

/**
 * Run the gate step against a fabricated check-runs answer.
 *
 * `conclusions` maps a required check name to its conclusion; a name left out
 * is absent from the API response, which the step reads as pending.
 *
 * Options can force API failures, drive the scheduled-sweep path, and add an
 * older completed suite so the harness also proves that a newer pending rerun
 * cannot be masked by its predecessor.
 */
function runGate(conclusions, {
  failedRunCreatedAt = '2026-08-12T12:15:00Z',
  failedRunSha = SHA,
  graphQlFailures = 0,
  graphQlFailureKind = 'generic',
  previousConclusions,
  resetAvailable = true,
  restFailures = 0,
  restFailureKind = 'generic',
  statusFailures = 0,
  statusFailureKind = 'generic',
  sweepStatus,
  sweepStatuses,
} = {}) {
  const tempDir = mkdtempSync(join(repoRoot, '.tmp-deploy-gate-'));
  const fakeBin = join(tempDir, 'bin');
  const runsFile = join(tempDir, 'check-runs.json');
  const failuresFile = join(tempDir, 'graphql-failures');
  const restFailuresFile = join(tempDir, 'rest-failures');
  const restRunsFile = join(tempDir, 'rest-check-runs.json');
  const statusFailuresFile = join(tempDir, 'status-failures');
  const sweepFile = join(tempDir, 'sweep.json');
  const postedFile = join(tempDir, 'posted');
  const postTargetsFile = join(tempDir, 'post-targets');
  const rejectedFile = join(tempDir, 'rejected');
  const callsFile = join(tempDir, 'calls');

  try {
    mkdirSync(fakeBin);
    writeFileSync(failuresFile, String(graphQlFailures));
    writeFileSync(restFailuresFile, String(restFailures));
    writeFileSync(statusFailuresFile, String(statusFailures));
    writeFileSync(postedFile, '');
    writeFileSync(postTargetsFile, '');
    writeFileSync(rejectedFile, '');
    writeFileSync(callsFile, '');
    const runsFor = (values, timestamp, idBase) => REQUIRED.flatMap((name, index) => values?.[name]
      ? [{
        name,
        conclusion: values[name] === 'pending' ? null : values[name].toUpperCase(),
        databaseId: idBase + index,
        completedAt: values[name] === 'pending' ? null : timestamp,
        startedAt: values[name] === 'pending' ? null : timestamp,
      }]
      : []);
    const requiredRuns = [
      ...(previousConclusions
        ? runsFor(previousConclusions, '2026-08-10T04:00:00Z', 1000)
        : []),
      ...runsFor(conclusions, '2026-08-10T05:00:00Z', 2000),
    ];
    const filler = Array.from({ length: 100 }, (_, index) => ({
      name: `unrelated-${index}`,
      conclusion: 'SUCCESS',
      databaseId: index,
      completedAt: '2026-08-10T03:00:00Z',
      startedAt: '2026-08-10T02:00:00Z',
    }));
    // `gh api graphql --paginate --slurp` returns an array of page responses;
    // the workflow's jq projection then keeps only the required check names.
    writeFileSync(
      runsFile,
      JSON.stringify([{
        data: {
          repository: {
            object: {
              statusCheckRollup: {
                contexts: {
                  nodes: filler,
                  pageInfo: { hasNextPage: true, endCursor: 'page-two' },
                },
              },
            },
          },
        },
      }, {
        data: {
          repository: {
            object: {
              statusCheckRollup: {
                contexts: {
                  nodes: requiredRuns,
                  pageInfo: { hasNextPage: false, endCursor: 'done' },
                },
              },
            },
          },
        },
      }]),
    );
    const toRestRun = (run) => ({
      name: run.name,
      conclusion: run.conclusion,
      id: run.databaseId,
      started_at: run.startedAt,
      completed_at: run.completedAt,
    });
    writeFileSync(
      restRunsFile,
      JSON.stringify([{
        total_count: filler.length + requiredRuns.length,
        check_runs: [...filler.map(toRestRun), ...requiredRuns.map(toRestRun)],
      }]),
    );
    const sweepNode = (sha, status) => ({
      headRefOid: sha,
      commits: {
        nodes: [{
          commit: {
            status: {
              context: status,
            },
          },
        }],
      },
    });
    writeFileSync(
      sweepFile,
      JSON.stringify([{
        data: {
          repository: {
            pullRequests: {
              nodes: Array.from(
                { length: 100 },
                (_, index) => sweepNode(`other-${index}`, {
                  state: 'SUCCESS',
                  description: stamped('All required PR gates passed'),
                }),
              ),
              pageInfo: { hasNextPage: true, endCursor: 'page-two' },
            },
          },
        },
      }, {
        data: {
          repository: {
            pullRequests: {
              nodes: sweepStatuses?.map(({ sha, status }) => sweepNode(sha, status))
                ?? [sweepNode(SHA, sweepStatus ?? null)],
              pageInfo: { hasNextPage: false, endCursor: 'done' },
            },
          },
        },
      }]),
    );

    // The fake keeps the production failure semantics: gh exits non-zero on an
    // API error, rate-limit recovery must consult the reset time, and commit
    // statuses reject descriptions over GitHub's real 140-character cap.
    writeFileSync(
      join(fakeBin, 'gh'),
      [
        '#!/bin/sh',
        'if [ "$1" = "api" ] && [ "$2" = "rate_limit" ]; then',
        '  case "$*" in',
        '    *".resources.graphql.reset"*) resource=graphql ;;',
        '    *".resources.core.reset"*) resource=core ;;',
        '    *) resource=unknown ;;',
        '  esac',
        '  echo "rate-limit:$resource" >> "$FAKE_CALLS"',
        '  [ "$FAKE_RESET_AVAILABLE" = "1" ] && printf \'%s\\n\' "$FAKE_RESET_AT"',
        '  exit 0',
        'fi',
        'case "$*" in',
        '  *"pullRequests(first:"*)',
        '    paginate=0',
        '    slurp=0',
        '    for arg in "$@"; do',
        '      [ "$arg" = "--paginate" ] && paginate=1',
        '      [ "$arg" = "--slurp" ] && slurp=1',
        '    done',
        '    echo "graphql-sweep-page" >> "$FAKE_CALLS"',
        '    if [ "$paginate" = "1" ]; then',
        '      echo "graphql-sweep-page" >> "$FAKE_CALLS"',
        '      [ "$slurp" = "1" ] || exit 96',
        '      cat "$FAKE_SWEEP_RESPONSES"',
        '    else',
        '      jq -c \'[.[0]]\' "$FAKE_SWEEP_RESPONSES"',
        '    fi',
        '    exit 0',
        '    ;;',
        '  *"statusCheckRollup"*)',
        '    paginate=0',
        '    slurp=0',
        '    for arg in "$@"; do',
        '      [ "$arg" = "--paginate" ] && paginate=1',
        '      [ "$arg" = "--slurp" ] && slurp=1',
        '    done',
        '    echo "graphql-check-page" >> "$FAKE_CALLS"',
        '    failures=$(cat "$FAKE_FAILURES")',
        '    if [ "$failures" -gt 0 ]; then',
        '      echo $((failures - 1)) > "$FAKE_FAILURES"',
        '      if [ "$FAKE_FAILURE_KIND" = "rate_limit" ]; then',
        '        echo "gh: API rate limit exceeded for installation (HTTP 403)" >&2',
        '      else',
        '        echo "gh: forced GraphQL failure (HTTP 500)" >&2',
        '      fi',
        '      exit 1',
        '    fi',
        '    body=$(cat "$FAKE_CHECK_RUNS")',
        '    if [ "$paginate" = "1" ]; then',
        '      echo "graphql-check-page" >> "$FAKE_CALLS"',
        '      [ "$slurp" = "1" ] || exit 96',
        '      printf \'%s\' "$body"',
        '    else',
        '      printf \'%s\' "$body" | jq -c \'[.[0]]\'',
        '    fi',
        '    exit 0',
        '    ;;',
        '  *"/check-runs"*)',
        '    echo "rest-check-runs-page" >> "$FAKE_CALLS"',
        '    rest_failures=$(cat "$FAKE_REST_FAILURES")',
        '    if [ "$rest_failures" -gt 0 ]; then',
        '      echo $((rest_failures - 1)) > "$FAKE_REST_FAILURES"',
        '      if [ "$FAKE_REST_FAILURE_KIND" = "rate_limit" ]; then',
        '        echo "gh: API rate limit exceeded for installation (HTTP 403)" >&2',
        '      else',
        '        echo "gh: forced REST check-runs failure (HTTP 503)" >&2',
        '      fi',
        '      exit 1',
        '    fi',
        '    paginate=0',
        '    slurp=0',
        '    for arg in "$@"; do',
        '      [ "$arg" = "--paginate" ] && paginate=1',
        '      [ "$arg" = "--slurp" ] && slurp=1',
        '    done',
        '    if [ "$paginate" = "1" ]; then',
        '      [ "$slurp" = "1" ] || exit 96',
        '      cat "$FAKE_REST_CHECK_RUNS"',
        '    else',
        '      jq -c \'[.[0]]\' "$FAKE_REST_CHECK_RUNS"',
        '    fi',
        '    exit 0',
        '    ;;',
        '  *"actions/workflows/deploy-gate.yml/runs"*)',
        '    echo "rest-failed-runs-page" >> "$FAKE_CALLS"',
        '    printf \'[{"workflow_runs":[{"created_at":"%s","display_title":"Deploy Gate %s"}]}]\' "$FAKE_FAILED_RUN_CREATED_AT" "$FAKE_FAILED_RUN_SHA"',
        '    exit 0',
        '    ;;',
        '  *"/statuses/"*)',
        '    state=""',
        '    description=""',
        '    target_sha=${2##*/}',
        '    for arg in "$@"; do',
        '      case "$arg" in',
        '        state=*) state=${arg#state=} ;;',
        '        description=*) description=${arg#description=} ;;',
        '      esac',
        '    done',
        '    echo "status:$state" >> "$FAKE_CALLS"',
        '    status_failures=$(cat "$FAKE_STATUS_FAILURES")',
        '    if [ "$status_failures" -gt 0 ]; then',
        '      echo $((status_failures - 1)) > "$FAKE_STATUS_FAILURES"',
        '      if [ "$FAKE_STATUS_FAILURE_KIND" = "rate_limit" ]; then',
        '        echo "gh: API rate limit exceeded for installation (HTTP 403)" >&2',
        '      else',
        '        echo "gh: forced commit-status failure (HTTP 500)" >&2',
        '      fi',
        '      exit 1',
        '    fi',
        '    if [ "${#description}" -gt 140 ]; then',
        '      printf \'%s|%s\\n\' "$state" "$description" >> "$FAKE_REJECTED"',
        '      echo "gh: Validation failed: Description is too long (maximum is 140 characters) (Validation Failed)" >&2',
        '      exit 1',
        '    fi',
        '    printf \'%s|%s\\n\' "$state" "$description" >> "$FAKE_POSTED"',
        '    printf \'%s\\n\' "$target_sha" >> "$FAKE_POST_TARGETS"',
        '    exit 0',
        '    ;;',
        'esac',
        'exit 90',
        '',
      ].join('\n'),
    );
    // The step sleeps between poll attempts and may wait for a rate-limit reset;
    // neither delay should slow this deterministic harness.
    writeFileSync(join(fakeBin, 'date'), [
      '#!/bin/sh',
      'case "$*" in',
      '  *"+%Y-%m-%dT%H:%M:%SZ"*) printf \'%s\\n\' "$FAKE_CUTOFF_ISO" ;;',
      '  *) printf \'%s\\n\' "$FAKE_NOW" ;;',
      'esac',
      '',
    ].join('\n'));
    writeFileSync(join(fakeBin, 'sleep'), [
      '#!/bin/sh',
      'echo "sleep:$1" >> "$FAKE_CALLS"',
      'exit 0',
      '',
    ].join('\n'));
    for (const command of ['gh', 'date', 'sleep']) chmodSync(join(fakeBin, command), 0o755);

    const result = spawnSync('bash', ['-e', '-c', gateStep.run], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_CALLS: callsFile,
        FAKE_CHECK_RUNS: runsFile,
        FAKE_CUTOFF_ISO: '2026-08-11T12:30:00Z',
        FAKE_FAILED_RUN_CREATED_AT: failedRunCreatedAt,
        FAKE_FAILED_RUN_SHA: failedRunSha,
        FAKE_FAILURE_KIND: graphQlFailureKind,
        FAKE_FAILURES: failuresFile,
        FAKE_REST_CHECK_RUNS: restRunsFile,
        FAKE_REST_FAILURE_KIND: restFailureKind,
        FAKE_REST_FAILURES: restFailuresFile,
        FAKE_POSTED: postedFile,
        FAKE_POST_TARGETS: postTargetsFile,
        FAKE_REJECTED: rejectedFile,
        FAKE_NOW: String(Date.parse('2026-08-12T12:30:00Z') / 1000),
        FAKE_RESET_AT: String(Date.parse('2026-08-12T12:30:10Z') / 1000),
        FAKE_RESET_AVAILABLE: resetAvailable ? '1' : '0',
        FAKE_STATUS_FAILURE_KIND: statusFailureKind,
        FAKE_STATUS_FAILURES: statusFailuresFile,
        FAKE_SWEEP_RESPONSES: sweepFile,
        FAKE_SHA: SHA,
        GH_TOKEN: 'test-token',
        PATH: `${fakeBin}:${process.env.PATH}`,
        REPO: 'koala73/worldmonitor',
        RUNNER_TEMP: tempDir,
        SHA: sweepStatus === undefined && sweepStatuses === undefined ? SHA : '',
      },
    });

    const parse = (file) => readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('|');
        return { state: line.slice(0, separator), description: line.slice(separator + 1) };
      });

    return {
      ...result,
      calls: readFileSync(callsFile, 'utf8').split('\n').filter(Boolean),
      postTargets: readFileSync(postTargetsFile, 'utf8').split('\n').filter(Boolean),
      posted: parse(postedFile),
      rejected: parse(rejectedFile),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const conclusionsFor = (value) => Object.fromEntries(REQUIRED.map((name) => [name, value]));

describe('deploy gate commit-status description', () => {
  it('gates on enough checks for the cap to be reachable', () => {
    // Anti-vacuity: with three required names the untruncated description fits
    // and every assertion below would pass against the broken step too.
    assert.ok(REQUIRED.length >= 10, `expected the full required list, found ${REQUIRED.length}`);
    assert.ok(
      `Waiting for required PR gates (${REQUIRED.length}): ${REQUIRED.join(',')}`.length > 140,
      'the fabricated worst case must actually exceed the API cap',
    );
  });

  it('posts a pending status when every required check is pending', () => {
    // #6389 reproduced: 20 pending names is ~300 characters, and the step used
    // to die on the 422 instead of posting anything.
    const result = runGate({});

    assert.deepEqual(result.rejected, [], `the API rejected a description: ${result.stderr}`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.posted.length, 1);
    assert.equal(result.posted[0].state, 'pending');
    assert.ok(result.posted[0].description.length <= 140);
    assert.match(result.posted[0].description, new RegExp(`Waiting for required PR gates \\(${REQUIRED.length}\\):`));
    assert.ok(
      result.posted[0].description.endsWith(`... ${GATE_STAMP}`),
      'a truncated description must say it was cut and preserve the contract stamp',
    );
    assert.deepEqual(
      result.calls,
      [
        'graphql-check-page',
        'graphql-check-page',
        'sleep:60',
        'graphql-check-page',
        'graphql-check-page',
        'status:pending',
      ],
      'the pending path must use five HTTP calls, down from eleven, with one bounded wait',
    );
  });

  it('posts a failure status when every required check failed', () => {
    // The arm that matters most: crashing here left NO gate status, and every
    // consumer reads a missing status as undecided rather than failed.
    const result = runGate(conclusionsFor('failure'));

    assert.deepEqual(result.rejected, [], `the API rejected a description: ${result.stderr}`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.posted.length, 1);
    assert.equal(result.posted[0].state, 'failure');
    assert.ok(result.posted[0].description.length <= 140);
    assert.match(result.posted[0].description, new RegExp(`Required PR gates did not pass \\(${REQUIRED.length}\\):`));
    assert.ok(
      result.posted[0].description.endsWith(`... ${GATE_STAMP}`),
      'a truncated failure description must preserve the contract stamp',
    );
  });

  it('keeps the whole list when it fits', () => {
    const conclusions = conclusionsFor('success');
    delete conclusions.unit;
    delete conclusions.biome;
    const result = runGate(conclusions);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.posted[0].state, 'pending');
    assert.equal(result.posted[0].description, stamped('Waiting for required PR gates (2): unit,biome'));
    assert.doesNotMatch(result.posted[0].description, /\.\.\. /, 'a description that fits must not be cut');
  });

  it('still posts success when everything passed or skipped', () => {
    const conclusions = conclusionsFor('success');
    conclusions['desktop-rust'] = 'skipped';
    const result = runGate(conclusions);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.posted, [
      { state: 'success', description: stamped('All required PR gates passed') },
    ]);
    assert.deepEqual(result.calls, ['graphql-check-page', 'graphql-check-page', 'status:success']);
  });

  it('does not let an older completed run mask a newer pending rerun', () => {
    const current = conclusionsFor('success');
    current.unit = 'pending';
    const result = runGate(current, { previousConclusions: conclusionsFor('success') });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.posted.at(-1).state, 'pending');
    assert.match(result.posted.at(-1).description, /unit/);
  });

  it('falls back to REST check-runs when GraphQL is unavailable', () => {
    const result = runGate(conclusionsFor('success'), { graphQlFailures: 1 });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.posted, [
      { state: 'success', description: stamped('All required PR gates passed') },
    ]);
    assert.deepEqual(result.calls, [
      'graphql-check-page',
      'rest-check-runs-page',
      'status:success',
    ]);
  });

  it('leaves a named pending gate when GraphQL and REST check reads both crash, then self-heals on the next evaluation', () => {
    const crashed = runGate(conclusionsFor('success'), { graphQlFailures: 1, restFailures: 1 });

    assert.notEqual(crashed.status, 0, 'the forced API failure must actually crash the evaluation');
    assert.deepEqual(crashed.posted, [
      { state: 'pending', description: stamped('Deploy Gate could not evaluate; retry scheduled') },
    ]);

    const healed = runGate(conclusionsFor('success'), {
      sweepStatus: {
        state: 'PENDING',
        description: stamped('Deploy Gate could not evaluate; retry scheduled'),
      },
    });
    assert.equal(healed.status, 0, healed.stderr);
    assert.deepEqual(healed.posted.at(-1), {
      state: 'success',
      description: stamped('All required PR gates passed'),
    });
    assert.deepEqual(
      healed.calls.slice(0, 2),
      ['graphql-sweep-page', 'graphql-sweep-page'],
      'a pending gate beyond the first 100 open PRs must enter recovery',
    );
  });

  it('invalidates and evaluates stale contracts before current pending gates', () => {
    const staleSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const pendingSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const oldStamp = '[gate-contract:001122334455]';
    const result = runGate(conclusionsFor('success'), {
      // Put pending first in the API response and duplicate the stale SHA. The
      // workflow must still invalidate/evaluate stale first, exactly once.
      sweepStatuses: [
        {
          sha: pendingSha,
          status: {
            state: 'PENDING',
            description: stamped('Deploy Gate could not evaluate; retry scheduled'),
          },
        },
        {
          sha: staleSha,
          status: {
            state: 'SUCCESS',
            description: `All required PR gates passed ${oldStamp}`,
          },
        },
        {
          sha: staleSha,
          status: {
            state: 'SUCCESS',
            description: `All required PR gates passed ${oldStamp}`,
          },
        },
      ],
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, [
      'graphql-sweep-page',
      'graphql-sweep-page',
      'status:pending',
      'graphql-check-page',
      'graphql-check-page',
      'status:success',
      'graphql-check-page',
      'graphql-check-page',
      'status:success',
    ]);
    assert.deepEqual(result.posted, [
      {
        state: 'pending',
        description: stamped('Required PR gate contract changed; re-evaluation scheduled'),
      },
      { state: 'success', description: stamped('All required PR gates passed') },
      { state: 'success', description: stamped('All required PR gates passed') },
    ]);
    assert.deepEqual(result.postTargets, [staleSha, staleSha, pendingSha]);
  });

  it('does not sleep or retry a stale contract after invalidating it', () => {
    const conclusions = conclusionsFor('success');
    conclusions.unit = 'pending';
    const result = runGate(conclusions, {
      sweepStatus: {
        state: 'SUCCESS',
        description: 'All required PR gates passed [gate-contract:001122334455]',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, [
      'graphql-sweep-page',
      'graphql-sweep-page',
      'status:pending',
      'graphql-check-page',
      'graphql-check-page',
      'status:pending',
    ]);
    assert.deepEqual(result.posted, [
      {
        state: 'pending',
        description: stamped('Required PR gate contract changed; re-evaluation scheduled'),
      },
      {
        state: 'pending',
        description: stamped('Waiting for required PR gates (1): unit'),
      },
    ]);
  });

  it('invalidates stale contracts before missing-status recovery reads', () => {
    const staleSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const missingSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const result = runGate(conclusionsFor('success'), {
      failedRunSha: missingSha,
      sweepStatuses: [
        {
          sha: staleSha,
          status: {
            state: 'SUCCESS',
            description: 'All required PR gates passed [gate-contract:001122334455]',
          },
        },
        { sha: missingSha, status: null },
      ],
    });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      result.calls.indexOf('status:pending') < result.calls.indexOf('rest-failed-runs-page'),
      'stale success must become fail-closed before the missing-status API lookup can wait or fail',
    );
    assert.deepEqual(result.postTargets.slice(0, 3), [staleSha, staleSha, missingSha]);
  });

  it('retries every stale contract whose first invalidation write fails', () => {
    const firstStaleSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const secondStaleSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const result = runGate(conclusionsFor('success'), {
      statusFailures: 2,
      sweepStatuses: [
        {
          sha: firstStaleSha,
          status: {
            state: 'SUCCESS',
            description: 'All required PR gates passed [gate-contract:001122334455]',
          },
        },
        {
          sha: secondStaleSha,
          status: {
            state: 'SUCCESS',
            description: 'All required PR gates passed [gate-contract:001122334455]',
          },
        },
      ],
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls.slice(0, 6), [
      'graphql-sweep-page',
      'graphql-sweep-page',
      'status:pending',
      'status:pending',
      'status:pending',
      'status:pending',
    ]);
    assert.deepEqual(result.posted.slice(0, 2), [
      {
        state: 'pending',
        description: stamped('Required PR gate contract changed; re-evaluation scheduled'),
      },
      {
        state: 'pending',
        description: stamped('Required PR gate contract changed; re-evaluation scheduled'),
      },
    ]);
    assert.deepEqual(result.postTargets, [
      firstStaleSha,
      secondStaleSha,
      firstStaleSha,
      secondStaleSha,
    ]);
  });

  it('backs off to the installation reset and retries a rate-limited read once', () => {
    const result = runGate(conclusionsFor('success'), {
      graphQlFailures: 1,
      graphQlFailureKind: 'rate_limit',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, [
      'graphql-check-page',
      'rate-limit:graphql',
      'sleep:15',
      'graphql-check-page',
      'graphql-check-page',
      'status:success',
    ]);
  });

  it('falls back to REST after a persistent GraphQL rate limit', () => {
    const result = runGate(conclusionsFor('success'), {
      graphQlFailures: 2,
      graphQlFailureKind: 'rate_limit',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.posted, [
      { state: 'success', description: stamped('All required PR gates passed') },
    ]);
    assert.ok(result.calls.includes('rest-check-runs-page'));
    assert.ok(result.calls.includes('status:success'));
  });

  it('posts pending when GraphQL reset is unavailable and REST also fails', () => {
    const result = runGate(conclusionsFor('success'), {
      graphQlFailures: 1,
      graphQlFailureKind: 'rate_limit',
      resetAvailable: false,
      restFailures: 1,
    });

    assert.notEqual(result.status, 0, 'an unavailable reset plus REST failure must fail the evaluation');
    assert.deepEqual(result.calls, [
      'graphql-check-page',
      'rate-limit:graphql',
      'rest-check-runs-page',
      'status:pending',
    ]);
    assert.deepEqual(result.posted, [
      { state: 'pending', description: stamped('Deploy Gate could not evaluate; retry scheduled') },
    ]);
  });

  it('posts pending when GraphQL reset is unavailable unless REST answers', () => {
    const result = runGate(conclusionsFor('success'), {
      graphQlFailures: 1,
      graphQlFailureKind: 'rate_limit',
      resetAvailable: false,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, [
      'graphql-check-page',
      'rate-limit:graphql',
      'rest-check-runs-page',
      'status:success',
    ]);
    assert.deepEqual(result.posted, [
      { state: 'success', description: stamped('All required PR gates passed') },
    ]);
  });

  it('falls back to pending when the verdict status write fails', () => {
    const result = runGate(conclusionsFor('success'), { statusFailures: 1 });

    assert.notEqual(result.status, 0, 'the forced status failure must fail the evaluation');
    assert.deepEqual(result.calls, [
      'graphql-check-page',
      'graphql-check-page',
      'status:success',
      'status:pending',
    ]);
    assert.deepEqual(result.posted, [
      { state: 'pending', description: stamped('Deploy Gate could not evaluate; retry scheduled') },
    ]);
  });

  it('retries a rate-limited verdict status write', () => {
    const result = runGate(conclusionsFor('success'), {
      statusFailures: 1,
      statusFailureKind: 'rate_limit',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, [
      'graphql-check-page',
      'graphql-check-page',
      'status:success',
      'rate-limit:core',
      'sleep:15',
      'status:success',
    ]);
    assert.deepEqual(result.posted, [
      { state: 'success', description: stamped('All required PR gates passed') },
    ]);
  });

  it('heals a recent missing gate after both status writes fail', () => {
    const stranded = runGate(conclusionsFor('success'), { statusFailures: 2 });

    assert.notEqual(stranded.status, 0, 'both status writes must fail the first evaluation');
    assert.deepEqual(stranded.posted, []);
    assert.deepEqual(stranded.calls.slice(-2), ['status:success', 'status:pending']);

    const healed = runGate(conclusionsFor('success'), { sweepStatus: null });
    assert.equal(healed.status, 0, healed.stderr);
    assert.deepEqual(healed.calls.slice(0, 2), ['graphql-sweep-page', 'graphql-sweep-page']);
    assert.equal(healed.calls[2], 'rest-failed-runs-page');
    assert.deepEqual(healed.posted.at(-1), {
      state: 'success',
      description: stamped('All required PR gates passed'),
    });
  });

  it('does not recover a missing gate without a matching recent failed run', () => {
    const result = runGate(conclusionsFor('success'), {
      failedRunSha: '0123456789abcdef0123456789abcdef01234567',
      sweepStatus: null,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, [
      'graphql-sweep-page',
      'graphql-sweep-page',
      'rest-failed-runs-page',
    ]);
    assert.deepEqual(result.posted, []);
  });

  it('does not recover a missing gate from a stale failed run', () => {
    const result = runGate(conclusionsFor('success'), {
      failedRunCreatedAt: '2026-08-10T12:15:00Z',
      sweepStatus: null,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, [
      'graphql-sweep-page',
      'graphql-sweep-page',
      'rest-failed-runs-page',
    ]);
    assert.deepEqual(result.posted, []);
  });
});
