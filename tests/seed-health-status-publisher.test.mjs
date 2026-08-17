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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publisher = resolve(repoRoot, 'scripts/update-seed-health-statuses.mjs');
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ANCESTOR = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const failure = {
  context: 'ingestion/seed/example',
  state: 'failure',
  description: 'STALE_SEED blocks operational acceptance',
};
const aggregate = {
  context: 'ingestion/seed/acceptance',
  state: 'pending',
  description: '1 source incident remains active',
};

function observation(blocking) {
  return {
    version: 1,
    checkedAt: '2026-08-17T18:00:00.000Z',
    acceptance: {
      blocking,
      acknowledged: [],
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
    writeFileSync(reportPath, JSON.stringify(observationOverride ?? observation(blocking)));
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
      'case "$2" in',
      '  --paginate)',
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
      '  --method)',
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
    const first = runPublisher({ blocking: currentProblem });
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
      ancestorStatuses: [aggregate, failure],
    });
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.match(repeated.stdout, /"newOrChangedFailures": \[\]/);
    assert.match(repeated.posts, /context=ingestion\/seed\/example/);
    assert.match(repeated.posts, /state=failure/);

    const sameRevision = runPublisher({
      blocking: currentProblem,
      headStatuses: [aggregate, failure],
    });
    assert.equal(sameRevision.status, 0, sameRevision.stderr);
    assert.equal(sameRevision.posts, '', 'an unchanged poll on the same SHA must not duplicate statuses');

    const recovered = runPublisher({
      blocking: [],
      ancestorStatuses: [aggregate, failure],
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
      headStatuses: [failure, aggregate],
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.posts, /context=ingestion\/seed\/example/);
    assert.match(result.posts, /context=ingestion\/seed\/acceptance/);
  });
});
