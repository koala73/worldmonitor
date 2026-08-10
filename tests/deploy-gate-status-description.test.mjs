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
const REQUIRED = JSON.parse(gateStep.run.match(/required='(\[[^']*\])'/)[1]);

/**
 * Run the gate step against a fabricated check-runs answer.
 *
 * `conclusions` maps a required check name to its conclusion; a name left out
 * is absent from the API response, which the step reads as pending.
 *
 * `fillerFirstPage` reproduces production: `filter=latest` returns one entry
 * per check-run NAME, a push to main carries more than 100 of them, and on
 * d38195c86 page one held ZERO of the 20 required names. Pass it to put the
 * required entries on page two, where only a paginated read can see them.
 */
function runGate(conclusions, { fillerFirstPage = 0 } = {}) {
  const tempDir = mkdtempSync(join(repoRoot, '.tmp-deploy-gate-'));
  const fakeBin = join(tempDir, 'bin');
  const runsFile = join(tempDir, 'check-runs.json');
  const postedFile = join(tempDir, 'posted');
  const rejectedFile = join(tempDir, 'rejected');

  try {
    mkdirSync(fakeBin);
    writeFileSync(postedFile, '');
    writeFileSync(rejectedFile, '');
    const required = Object.entries(conclusions).map(([name, conclusion]) => ({
      name,
      conclusion,
      completed_at: '2026-08-10T05:00:00Z',
    }));
    const filler = Array.from({ length: fillerFirstPage }, (_, index) => ({
      name: `indexnow-submit-${index}`,
      conclusion: 'skipped',
      completed_at: '2026-08-10T05:00:00Z',
    }));
    // The shape gh returns: one object per page, and `--slurp` wraps them in an
    // array. Without pagination the caller sees page one and nothing else.
    writeFileSync(
      runsFile,
      JSON.stringify(
        fillerFirstPage > 0
          ? [{ check_runs: filler }, { check_runs: required }]
          : [{ check_runs: required }],
      ),
    );

    // Three behaviours matter, and each is a real API behaviour rather than a
    // convenience. The check-runs read serves ONLY page one unless --paginate
    // is passed, and applies a --jq filter itself when given one, so a step
    // that forgets to paginate sees exactly what production saw. The status
    // POST enforces the real 140-character cap the way the API does — a 422 and
    // a non-zero exit — so this harness reproduces #6389 rather than describing
    // it.
    writeFileSync(
      join(fakeBin, 'gh'),
      [
        '#!/bin/sh',
        'case "$*" in',
        '  *"/check-runs"*)',
        '    filter=""',
        '    take_next=0',
        '    paginate=0',
        '    for arg in "$@"; do',
        '      if [ "$take_next" = "1" ]; then filter="$arg"; take_next=0; continue; fi',
        '      case "$arg" in',
        '        --jq|-q) take_next=1 ;;',
        '        --paginate) paginate=1 ;;',
        '      esac',
        '    done',
        '    if [ "$paginate" = "1" ]; then',
        // gh refuses --slurp together with --jq, and without --slurp a paginated
        // read emits bare concatenated page bodies rather than the array the
        // filter indexes. Half a pagination fix must not pass here.
        '      case " $* " in *" --slurp "*) ;; *) exit 96 ;; esac',
        '      body=$(cat "$FAKE_CHECK_RUNS")',
        '    else',
        '      body=$(jq -c \'.[0]\' "$FAKE_CHECK_RUNS")',
        '    fi',
        '    if [ -n "$filter" ]; then',
        '      printf \'%s\' "$body" | jq -c "$filter"',
        '    else',
        '      printf \'%s\' "$body"',
        '    fi',
        '    exit 0',
        '    ;;',
        '  *"/statuses/"*)',
        '    state=""',
        '    description=""',
        '    for arg in "$@"; do',
        '      case "$arg" in',
        '        state=*) state=${arg#state=} ;;',
        '        description=*) description=${arg#description=} ;;',
        '      esac',
        '    done',
        '    if [ "${#description}" -gt 140 ]; then',
        '      printf \'%s|%s\\n\' "$state" "$description" >> "$FAKE_REJECTED"',
        '      echo "gh: Validation failed: Description is too long (maximum is 140 characters) (Validation Failed)" >&2',
        '      exit 1',
        '    fi',
        '    printf \'%s|%s\\n\' "$state" "$description" >> "$FAKE_POSTED"',
        '    exit 0',
        '    ;;',
        'esac',
        'exit 90',
        '',
      ].join('\n'),
    );
    // The step sleeps 30s between poll attempts; four of those would make this
    // suite take two minutes to learn nothing.
    writeFileSync(join(fakeBin, 'sleep'), ['#!/bin/sh', 'exit 0', ''].join('\n'));
    for (const command of ['gh', 'sleep']) chmodSync(join(fakeBin, command), 0o755);

    const result = spawnSync('bash', ['-e', '-c', gateStep.run], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_CHECK_RUNS: runsFile,
        FAKE_POSTED: postedFile,
        FAKE_REJECTED: rejectedFile,
        GH_TOKEN: 'test-token',
        PATH: `${fakeBin}:${process.env.PATH}`,
        REPO: 'koala73/worldmonitor',
        SHA,
      },
    });

    const parse = (file) => readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('|');
        return { state: line.slice(0, separator), description: line.slice(separator + 1) };
      });

    return { ...result, posted: parse(postedFile), rejected: parse(rejectedFile) };
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
    assert.match(result.posted[0].description, /\.\.\.$/, 'a truncated description must say it was cut');
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
  });

  it('keeps the whole list when it fits', () => {
    const conclusions = conclusionsFor('success');
    delete conclusions.unit;
    delete conclusions.biome;
    const result = runGate(conclusions);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.posted[0].state, 'pending');
    assert.equal(result.posted[0].description, 'Waiting for required PR gates (2): unit,biome');
    assert.doesNotMatch(result.posted[0].description, /\.\.\.$/, 'a description that fits must not be cut');
  });

  it('reads every page, so a required check on page two is not read as pending', () => {
    // What actually happened on d38195c86: 153 check runs, and an un-paginated
    // read of the first 100 held ZERO of the 20 required names. The gate posted
    // `Waiting for required PR gates (6): …` over six checks that had already
    // passed, and nothing re-evaluates a main commit — the self-healing sweep
    // walks open PR heads only. Before #6390 the same misread produced all 20
    // names, a ~300-character description and a 422 that posted nothing at all.
    const result = runGate(conclusionsFor('success'), { fillerFirstPage: 100 });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      result.posted,
      [{ state: 'success', description: 'All required PR gates passed' }],
      'every required check passed on page two; a gate that cannot see page two invents a pending verdict',
    );
  });

  it('still posts success when everything passed or skipped', () => {
    const conclusions = conclusionsFor('success');
    conclusions['desktop-rust'] = 'skipped';
    const result = runGate(conclusions);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.posted, [{ state: 'success', description: 'All required PR gates passed' }]);
  });
});
