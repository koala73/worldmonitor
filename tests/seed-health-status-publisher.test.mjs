import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

import { buildSeedHealthStatuses, validateObservationCheckedAt } from '../scripts/update-seed-health-statuses.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publisher = resolve(repoRoot, 'scripts/update-seed-health-statuses.mjs');
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ANCESTOR = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const WRITER = 'github-actions[bot]';

const failure = {
  context: 'ingestion/seed/example',
  state: 'failure',
  description: 'STALE_SEED blocks operational acceptance',
};
function aggregate(checkedAt) {
  return {
    context: 'ingestion/seed/acceptance',
    state: 'pending',
    description: `1 source incident remains active; observed ${checkedAt}`,
    creator: { login: WRITER },
  };
}

function trusted(status) {
  return { ...status, creator: { login: WRITER } };
}

function checkedAt(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function observation(blocking = [], { acknowledged = [], observedAt = checkedAt() } = {}) {
  return {
    version: 1,
    checkedAt: observedAt,
    acceptance: {
      blocking,
      acknowledged,
      cleared: [],
      escalated: [],
      expired: false,
      expiresAt: '2026-08-27',
    },
    report: { failed: blocking.length > 0 },
  };
}

function runPublisher({
  blocking,
  acknowledged,
  observedAt,
  headStatuses = [],
  ancestorStatuses = [],
  observationOverride,
}) {
  const tempDir = mkdtempSync(join(repoRoot, '.tmp-seed-status-publisher-'));
  const fakeBin = join(tempDir, 'bin');
  const statusesDir = join(tempDir, 'statuses');
  const reportPath = join(tempDir, 'observation.json');
  const postLog = join(tempDir, 'posts.log');
  try {
    mkdirSync(fakeBin);
    mkdirSync(statusesDir);
    writeFileSync(reportPath, JSON.stringify(observationOverride ?? observation(blocking, { acknowledged, observedAt })));
    writeFileSync(join(statusesDir, `${HEAD}.json`), JSON.stringify(headStatuses));
    writeFileSync(join(statusesDir, `${ANCESTOR}.json`), JSON.stringify(ancestorStatuses));
    writeFileSync(postLog, '');
    writeFileSync(join(fakeBin, 'git'), [
      '#!/bin/sh',
      'case "$1" in log) ;; *) exit 90 ;; esac',
      `printf '%s\\n%s\\n' '${HEAD}' '${ANCESTOR}'`,
      '',
    ].join('\n'));
    writeFileSync(join(fakeBin, 'gh'), [
      '#!/bin/sh',
      'case "$1:$2" in',
      '  api:--paginate)',
      '    sha=""',
      '    for arg in "$@"; do',
      '      case "$arg" in',
      '        */commits/*/statuses*)',
      '          rest=${arg#*/commits/}',
      '          sha=${rest%%/statuses*}',
      '          ;;',
      '      esac',
      '    done',
      '    [ -f "$FAKE_STATUS_DIR/$sha.json" ] || exit 91',
      '    printf "["',
      '    cat "$FAKE_STATUS_DIR/$sha.json"',
      '    printf "]\\n"',
      '    ;;',
      '  api:--method)',
      '    printf "%s\\n" "$*" >> "$FAKE_POST_LOG"',
      '    printf "{}\\n"',
      '    ;;',
      '  *) exit 92 ;;',
      'esac',
      '',
    ].join('\n'));
    chmodSync(join(fakeBin, 'git'), 0o755);
    chmodSync(join(fakeBin, 'gh'), 0o755);

    const result = spawnSync(process.execPath, [publisher, '--sha', HEAD, '--report', reportPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_POST_LOG: postLog,
        FAKE_STATUS_DIR: statusesDir,
        GH_TOKEN: 'test-token',
        GITHUB_REPOSITORY: 'koala73/worldmonitor',
        SEED_STATUS_WRITER_LOGIN: WRITER,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    });
    return { ...result, posts: readFileSync(postLog, 'utf8') };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('seed health status publisher', () => {
  it('fails once for a new incident, stays quiet for the same incident, and posts recovery', () => {
    const currentProblem = [{ name: 'example', status: 'STALE_SEED', seedAgeMin: 999 }];
    const firstAt = checkedAt(-120_000);
    const first = runPublisher({ blocking: currentProblem, observedAt: firstAt });
    assert.equal(first.status, 1, first.stderr);
    assert.match(`${first.stdout}\n${first.stderr}`, /ingestion\/seed\/example/);
    assert.match(first.posts, /state=failure/);
    assert.match(first.posts, /context=ingestion\/seed\/example/);
    assert.ok(
      first.posts.indexOf('context=ingestion/seed/example')
        < first.posts.indexOf('context=ingestion/seed/acceptance'),
      'the complete per-source projection must be posted before its acceptance marker',
    );

    const repeated = runPublisher({
      blocking: [{ ...currentProblem[0], seedAgeMin: 1_500 }],
      observedAt: checkedAt(-60_000),
      ancestorStatuses: [aggregate(firstAt), trusted(failure)],
    });
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.match(repeated.stdout, /"newOrChangedFailures": \[\]/);
    assert.match(repeated.posts, /context=ingestion\/seed\/example/);
    assert.match(repeated.posts, /state=failure/);

    const sameRevision = runPublisher({
      blocking: currentProblem,
      observedAt: firstAt,
      headStatuses: [aggregate(firstAt), trusted(failure)],
    });
    assert.equal(sameRevision.status, 1, sameRevision.stderr);
    assert.match(sameRevision.stderr, /not newer than completed projection/);

    const recovered = runPublisher({
      blocking: [],
      observedAt: checkedAt(-30_000),
      ancestorStatuses: [aggregate(firstAt), trusted(failure)],
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(recovered.posts, /context=ingestion\/seed\/example/);
    assert.match(recovered.posts, /state=success/);
    assert.match(recovered.posts, /description=recovered; no longer reported/);
  });

  it('fails closed when the structured verdict disagrees with its problem inventory', () => {
    const malformed = observation([]);
    malformed.report.failed = true;
    const result = runPublisher({ blocking: [], observationOverride: malformed });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /verdict does not match its problem inventory/);
    assert.equal(result.posts, '');
  });

  it('does not accept an old aggregate marker beneath a partial status projection', () => {
    const result = runPublisher({
      blocking: [{ name: 'example', status: 'STALE_SEED' }],
      // GitHub returns newest first. The source status is newer than the
      // aggregate marker, so the earlier write did not complete.
      headStatuses: [trusted(failure), aggregate(checkedAt(-60_000))],
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.posts, /context=ingestion\/seed\/example/);
    assert.match(result.posts, /context=ingestion\/seed\/acceptance/);
  });

  it('bootstraps from a trusted legacy completion marker instead of suppressing the first timestamped projection', () => {
    const result = runPublisher({
      blocking: [{ name: 'example', status: 'STALE_SEED' }],
      headStatuses: [
        trusted({
          context: 'ingestion/seed/acceptance',
          state: 'pending',
          description: '1 source incident remains active',
        }),
        trusted(failure),
      ],
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.posts, /context=ingestion\/seed\/example/);
    assert.match(result.posts, /observed \d{4}-\d{2}-\d{2}T/);
  });

  it('fails closed for a trusted completion marker with a malformed observed timestamp', () => {
    const result = runPublisher({
      blocking: [],
      headStatuses: [trusted({
        context: 'ingestion/seed/acceptance',
        state: 'success',
        description: 'ingestion operational acceptance passed; observed yesterday',
      })],
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /malformed observed checkedAt/);
    assert.equal(result.posts, '');
  });

  it('keeps a live acknowledged source pending and only recovers it after health clears it', () => {
    const observedAt = checkedAt(-60_000);
    const acknowledged = [{ name: 'example', status: 'EMPTY', issue: 1234 }];
    const statuses = buildSeedHealthStatuses({
      blocking: [],
      acknowledged,
      cleared: [],
      escalated: [],
      expired: false,
      expiresAt: '2026-08-27',
    }, observedAt);
    assert.deepEqual(statuses[1], {
      context: 'ingestion/seed/example',
      state: 'pending',
      description: 'EMPTY acknowledged by #1234',
    });

    const result = runPublisher({ acknowledged, observedAt });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.posts, /context=ingestion\/seed\/example/);
    assert.match(result.posts, /state=pending/);

    const recovered = runPublisher({
      observedAt: checkedAt(-30_000),
      ancestorStatuses: [
        trusted({
          context: 'ingestion/seed/acceptance',
          state: 'success',
          description: `ingestion operational acceptance passed; observed ${observedAt}`,
        }),
        trusted({
          context: 'ingestion/seed/example',
          state: 'pending',
          description: 'EMPTY acknowledged by #1234',
        }),
      ],
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(recovered.posts, /context=ingestion\/seed\/example/);
    assert.match(recovered.posts, /state=success/);
    assert.match(recovered.posts, /description=recovered; no longer reported/);
  });

  it('fails closed for malformed, stale, or future observation timestamps before posting', () => {
    assert.throws(
      () => validateObservationCheckedAt('2026-08-17T18:00:00Z', Date.now()),
      /normalized UTC ISO instant/,
    );
    assert.throws(
      () => validateObservationCheckedAt(checkedAt(-31 * 60_000), Date.now()),
      /freshness window/,
    );
    assert.throws(
      () => validateObservationCheckedAt(checkedAt(6 * 60_000), Date.now()),
      /freshness window/,
    );

    const malformed = observation([], { observedAt: '2026-08-17T18:00:00Z' });
    const result = runPublisher({ blocking: [], observationOverride: malformed });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /normalized UTC ISO instant/);
    assert.equal(result.posts, '');
  });

  it('rejects a delayed healthy observation after a newer completed failure', () => {
    const newerAt = checkedAt(-30_000);
    const delayed = runPublisher({
      blocking: [],
      observedAt: checkedAt(-90_000),
      ancestorStatuses: [aggregate(newerAt), trusted(failure)],
    });
    assert.equal(delayed.status, 1, delayed.stderr);
    assert.match(delayed.stderr, /not newer than completed projection/);
    assert.equal(delayed.posts, '');
  });

  it('fails closed when a completed projection was written by another account', () => {
    const observedAt = checkedAt(-30_000);
    const untrustedAggregate = {
      ...aggregate(checkedAt(-60_000)),
      creator: { login: 'untrusted-writer' },
    };
    const result = runPublisher({
      blocking: [{ name: 'example', status: 'STALE_SEED' }],
      observedAt,
      ancestorStatuses: [untrustedAggregate, trusted(failure)],
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /not created by trusted writer/);
    assert.equal(result.posts, '');
  });

  it('posts the acceptance completion marker last for a same-SHA changed observation', () => {
    const firstAt = checkedAt(-120_000);
    const secondAt = checkedAt(-60_000);
    const result = runPublisher({
      blocking: [{ name: 'example', status: 'EMPTY' }],
      observedAt: secondAt,
      headStatuses: [aggregate(firstAt), trusted(failure)],
    });
    assert.equal(result.status, 1, result.stderr);
    assert.ok(
      result.posts.indexOf('context=ingestion/seed/example')
        < result.posts.lastIndexOf('context=ingestion/seed/acceptance'),
      'same-SHA repairs must finish with the current acceptance marker',
    );
    assert.match(result.posts, /description=EMPTY blocks operational acceptance/);

    const unchanged = runPublisher({
      blocking: [{ name: 'example', status: 'EMPTY' }],
      observedAt: checkedAt(-30_000),
      headStatuses: [
        aggregate(secondAt),
        trusted({
          context: 'ingestion/seed/example',
          state: 'failure',
          description: 'EMPTY blocks operational acceptance',
        }),
      ],
    });
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.doesNotMatch(unchanged.posts, /context=ingestion\/seed\/example/);
    assert.match(unchanged.posts, /context=ingestion\/seed\/acceptance/);
  });
});
