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
 */
function runGate(conclusions) {
  const tempDir = mkdtempSync(join(repoRoot, '.tmp-deploy-gate-'));
  const fakeBin = join(tempDir, 'bin');
  const runsFile = join(tempDir, 'check-runs.json');
  const postedFile = join(tempDir, 'posted');
  const rejectedFile = join(tempDir, 'rejected');

  try {
    mkdirSync(fakeBin);
    writeFileSync(postedFile, '');
    writeFileSync(rejectedFile, '');
    writeFileSync(
      runsFile,
      JSON.stringify(
        Object.entries(conclusions).map(([name, conclusion]) => ({
          name,
          conclusion,
          completed_at: '2026-08-10T05:00:00Z',
        })),
      ),
    );

    // Two behaviours matter. The check-runs read returns the already-projected
    // array the step's own --jq would produce. The status POST enforces the
    // real 140-character cap the same way the API does — a 422 and a non-zero
    // exit — so this harness reproduces #6389 rather than describing it.
    writeFileSync(
      join(fakeBin, 'gh'),
      [
        '#!/bin/sh',
        'case "$*" in',
        '  *"/check-runs"*)',
        '    cat "$FAKE_CHECK_RUNS"',
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

  it('still posts success when everything passed or skipped', () => {
    const conclusions = conclusionsFor('success');
    conclusions['desktop-rust'] = 'skipped';
    const result = runGate(conclusions);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.posted, [{ state: 'success', description: 'All required PR gates passed' }]);
  });
});
