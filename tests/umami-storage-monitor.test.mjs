import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import {
  evaluateUmamiStorage,
  normalizeVolumeRows,
  parseArguments,
  updateStorageState,
} from '../scripts/check-umami-storage.mjs';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const storageCheckScript = fileURLToPath(
  new URL('../scripts/check-umami-storage.mjs', import.meta.url),
);
const workflowSource = readFileSync(
  new URL('../.github/workflows/umami-storage-monitor.yml', import.meta.url),
  'utf8',
);
const workflow = YAML.parse(workflowSource);
const retentionSql = readFileSync(
  new URL('../scripts/umami-retention.sql', import.meta.url),
  'utf8',
);
const executableRetentionSql = retentionSql.replace(/^\s*--.*$/gmu, '');

function volume(overrides = {}) {
  return {
    id: 'volume-1',
    name: 'postgres-volume',
    serviceName: 'Postgres Umami',
    sizeMB: 50_000,
    currentSizeMB: 28_000,
    status: 'Ready',
    ...overrides,
  };
}

function runStorageCheckCli({ currentSizeMB, samples = [], volumeOverrides = {} }) {
  const directory = mkdtempSync(join(tmpdir(), 'wm-umami-storage-monitor-'));
  const inputPath = join(directory, 'volumes.json');
  const statePath = join(directory, 'state.json');

  try {
    writeFileSync(inputPath, JSON.stringify([volume({ currentSizeMB, ...volumeOverrides })]));
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      volumeIdentity: 'volume-1',
      capacityMB: 50_000,
      samples,
    }));
    return spawnSync(
      process.execPath,
      [storageCheckScript, '--input', inputPath, '--state', statePath],
      {
        encoding: 'utf8',
        env: { ...process.env, UMAMI_POSTGRES_SERVICE_NAME: 'Postgres Umami' },
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('Umami storage monitor', () => {
  it('normalizes Railway array and connection-shaped volume responses', () => {
    assert.deepEqual(normalizeVolumeRows([volume()]), [volume()]);
    assert.deepEqual(normalizeVolumeRows({ volumes: [volume()] }), [volume()]);
    assert.deepEqual(
      normalizeVolumeRows({ volumes: { edges: [{ node: volume() }] } }),
      [volume()],
    );
  });

  it('parses only the documented input and state options', () => {
    assert.deepEqual(
      { ...parseArguments(['--input', 'volumes.json', '--state=state.json']) },
      { input: 'volumes.json', state: 'state.json' },
    );
    assert.throws(() => parseArguments(['--unknown', 'value']), /Unknown option/);
  });

  it('does not project headroom until there is a meaningful history window', () => {
    const result = evaluateUmamiStorage({
      volume: volume(),
      samples: [{ sampledAt: new Date(NOW - 60 * 60 * 1000).toISOString(), currentSizeMB: 27_900 }],
      now: NOW,
    });

    assert.equal(result.growthMBPerDay, null);
    assert.equal(result.projectedHeadroomDays, null);
    assert.equal(result.alerting, false);
  });

  it('alerts when projected capacity is inside the 30-day warning window', () => {
    const result = evaluateUmamiStorage({
      volume: volume({ currentSizeMB: 28_000 }),
      samples: [{ sampledAt: new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString(), currentSizeMB: 22_800 }],
      now: NOW,
    });

    assert.equal(Math.round(result.growthMBPerDay), 743);
    assert.equal(Math.round(result.projectedHeadroomDays), 30);
    assert.equal(result.status, 'warning');
    assert.equal(result.alerting, true);
  });

  it('fails closed at critical usage even when no growth baseline exists', () => {
    const result = evaluateUmamiStorage({
      volume: volume({ currentSizeMB: 45_000 }),
      samples: [],
      now: NOW,
    });

    assert.equal(result.usagePercent, 90);
    assert.equal(result.status, 'critical');
    assert.equal(result.alerting, true);
  });

  it('reports a capacity warning without failing the scheduled workflow', () => {
    const run = runStorageCheckCli({
      currentSizeMB: 28_000,
      samples: [{
        sampledAt: new Date(Date.now() - 7 * DAY_MS).toISOString(),
        currentSizeMB: 22_800,
      }],
    });

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Umami storage warning:/);
    assert.match(run.stderr, /::warning::Umami Postgres storage needs retention or capacity action/);
  });

  it('fails the scheduled workflow at critical capacity', () => {
    const run = runStorageCheckCli({ currentSizeMB: 45_000 });

    assert.equal(run.status, 1);
    assert.match(run.stdout, /Umami storage critical:/);
    assert.match(run.stderr, /::error::Umami Postgres storage is at a critical capacity/);
  });

  it('fails the scheduled workflow when Railway volume processing fails', () => {
    const run = runStorageCheckCli({
      currentSizeMB: 28_000,
      volumeOverrides: { status: 'Failed' },
    });

    assert.equal(run.status, 1);
    assert.match(run.stderr, /Umami storage monitor failed: Umami volume is not ready: Failed/);
  });

  it('fails closed when Railway reports a non-ready volume', () => {
    assert.throws(
      () => evaluateUmamiStorage({ volume: volume({ status: 'Failed' }), now: NOW }),
      /volume is not ready: Failed/,
    );
    assert.throws(
      () => evaluateUmamiStorage({ volume: volume({ status: undefined }), now: NOW }),
      /volume is not ready: unknown/,
    );
  });

  it('keeps only bounded, valid samples in the cached state', () => {
    const next = updateStorageState(
      {
        version: 1,
        volumeIdentity: 'volume-1',
        capacityMB: 50_000,
        samples: [
          { sampledAt: new Date(NOW - 31 * 24 * 60 * 60 * 1000).toISOString(), currentSizeMB: 10_000 },
          { sampledAt: new Date(NOW - 60 * 60 * 1000).toISOString(), currentSizeMB: 20_000 },
          { sampledAt: 'not-a-date', currentSizeMB: 30_000 },
        ],
      },
      volume({ currentSizeMB: 21_000 }),
      NOW,
    );

    assert.deepEqual(next, {
      version: 1,
      volumeIdentity: 'volume-1',
      capacityMB: 50_000,
      samples: [
        { sampledAt: new Date(NOW - 60 * 60 * 1000).toISOString(), currentSizeMB: 20_000 },
        { sampledAt: new Date(NOW).toISOString(), currentSizeMB: 21_000 },
      ],
    });
  });

  it('resets history when the volume identity or capacity changes', () => {
    const previous = {
      version: 1,
      volumeIdentity: 'old-volume',
      capacityMB: 25_000,
      samples: [{ sampledAt: new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString(), currentSizeMB: 10_000 }],
    };
    const next = updateStorageState(previous, volume({ currentSizeMB: 28_000 }), NOW);

    assert.deepEqual(next, {
      version: 1,
      volumeIdentity: 'volume-1',
      capacityMB: 50_000,
      samples: [{ sampledAt: new Date(NOW).toISOString(), currentSizeMB: 28_000 }],
    });
  });

  it('wires the read-only Railway check and bounded SQL contract', () => {
    assert.match(workflowSource, /railway volume .* list --json/);
    assert.match(workflowSource, /check-umami-storage\.mjs/);

    // The combined actions/cache declares `post-if: success()`, so its save is
    // skipped whenever the job fails — and this job can now fail on the
    // retention runner alarm. Split restore/save, with the save unconditional,
    // is what keeps the growth baseline accumulating across a red run.
    const saveStep = workflow.jobs.monitor.steps.find(
      (step) => (step.uses ?? '').startsWith('actions/cache/save@'),
    );
    assert.match(workflowSource, /actions\/cache\/restore@/);
    assert.ok(saveStep, 'the growth baseline must be saved by an explicit step');
    assert.equal(saveStep.if, '${{ !cancelled() }}');
    assert.doesNotMatch(
      workflowSource,
      /uses: actions\/cache@/,
      'the combined action would drop the sample on any failing run',
    );
    assert.match(retentionSql, /LIMIT 10000/);
    assert.match(retentionSql, /64 \* 1024 \* 1024/);
    assert.doesNotMatch(executableRetentionSql, /\bTRUNCATE\b/);
    assert.match(retentionSql, /to_regclass\('public\.session_link'\)/);
    assert.match(retentionSql, /session_link/);
    assert.match(retentionSql, /heatmap_event/);
    assert.match(retentionSql, /session_replay_saved/);
    assert.doesNotMatch(retentionSql, /ROW_NUMBER/);
  });

  it('declares the retention horizon once, and at a size the 50 GB volume holds', () => {
    const declarations = [...executableRetentionSql.matchAll(/\\set\s+retention_horizon\s+'([^']+)'/gu)];

    assert.equal(declarations.length, 1, 'the horizon must have exactly one definition');
    assert.equal(
      declarations[0][1],
      '30 days',
      '90 days needed ~79 GB of a 50 GB volume at ~0.9 GB per retained day (#6375)',
    );
    // Nothing may hard-code an interval alongside the declared horizon, or the
    // tables drift apart the next time somebody changes only one of them.
    assert.doesNotMatch(
      executableRetentionSql,
      /interval\s+'\d+\s+days?'/u,
      'every statement must read the declared horizon, not its own literal',
    );
  });

  it('never interpolates a psql variable inside a dollar-quoted block', () => {
    // psql substitutes :'var' only outside quotes. The identical text inside a
    // DO block's dollar-quoted body reaches the server verbatim and dies with
    // `syntax error at or near ":"`, which ON_ERROR_STOP turns into a crashed
    // tick. The two DO blocks read a session setting instead.
    const regions = [...executableRetentionSql.matchAll(/\$(\w*)\$([\s\S]*?)\$\1\$/gu)];
    assert.ok(regions.length >= 2, 'both DO blocks must be found, or this check proves nothing');
    for (const [, , body] of regions) {
      assert.doesNotMatch(
        body,
        /:'/u,
        'a dollar-quoted body must read current_setting(), not a psql variable',
      );
    }
    assert.match(
      executableRetentionSql,
      /SET worldmonitor\.umami_retention_horizon = :'retention_horizon';/u,
      'the session setting must be derived from the single declared horizon',
    );
    assert.match(
      executableRetentionSql,
      /current_setting\('worldmonitor\.umami_retention_horizon'\)::interval/u,
    );
  });

  it('commits each delete on its own so one slow statement cannot discard the tick', () => {
    // #6375: a single transaction wrapped all eight statements, so the 60s
    // cancellation on the website_event delete threw away the event_data
    // delete that had already reported `DELETE 1369`.
    const chunks = executableRetentionSql.split(/^COMMIT;$/mu);
    const bodies = chunks.filter((chunk) => /DELETE FROM|DO \$\$/u.test(chunk));

    assert.ok(bodies.length >= 8, `expected every retention statement to be committed, saw ${bodies.length}`);
    for (const body of bodies) {
      const opens = body.match(/^BEGIN;$/gmu) ?? [];
      assert.equal(opens.length, 1, `each committed unit opens exactly one transaction:\n${body.slice(0, 200)}`);
    }
    assert.equal(
      (executableRetentionSql.match(/^BEGIN;$/gmu) ?? []).length,
      (executableRetentionSql.match(/^COMMIT;$/gmu) ?? []).length,
      'every transaction this file opens must be committed',
    );
  });

  it('skips a busy tick instead of crashing, and allows a cold batch to finish', () => {
    assert.match(
      executableRetentionSql,
      /pg_try_advisory_lock\(hashtextextended\('worldmonitor\.umami\.retention', 0\)\)/u,
      'a blocking xact lock turns an overlapping tick into a crash, which is the alarm state',
    );
    assert.doesNotMatch(executableRetentionSql, /pg_advisory_xact_lock/u);
    assert.match(executableRetentionSql, /\\quit/u, 'a locked-out tick must exit 0');

    const [, timeout] = executableRetentionSql.match(/SET statement_timeout = '(\d+)s';/u) ?? [];
    assert.ok(timeout, 'the file must set its own statement timeout');
    // One 10,000-row website_event batch measured 15.0s warm and roughly four
    // times that cold; 60s sat inside that range and cancelled the tick.
    assert.ok(
      Number(timeout) >= 120,
      `statement_timeout ${timeout}s is inside the measured cold-batch range`,
    );
  });

  it('keeps the runbook numbers equal to the numbers the SQL actually uses', () => {
    // The runbook states the horizon and the timeout as fact, and an operator
    // mid-incident reads it as the live value. Nothing but this test stops the
    // SQL moving and the prose staying put — the timeout assertion above is a
    // floor on purpose (it encodes the measured cold-batch constraint, not one
    // blessed number), so a floor alone would let 300 -> 180 pass silently.
    const runbook = readFileSync(
      new URL('../docs/analytics-collector-operations.md', import.meta.url),
      'utf8',
    );

    const [, documentedHorizon] = runbook.match(/\*\*The horizon is ([^.*]+)\.\*\*/u) ?? [];
    const [, declaredHorizon] = executableRetentionSql.match(/\\set\s+retention_horizon\s+'([^']+)'/u) ?? [];
    assert.ok(documentedHorizon, 'the runbook must state the horizon');
    assert.equal(documentedHorizon, declaredHorizon);

    const [, documentedTimeout] = runbook.match(/\*\*`statement_timeout` is (\d+)s/u) ?? [];
    const [, declaredTimeout] = executableRetentionSql.match(/SET statement_timeout = '(\d+)s';/u) ?? [];
    assert.ok(documentedTimeout, 'the runbook must state the statement timeout');
    assert.equal(documentedTimeout, declaredTimeout);
  });

  it('supersedes stale probes without broadening production credential access', () => {
    assert.deepEqual(
      workflow.concurrency,
      {
        group: 'umami-storage-monitor-${{ github.ref }}',
        'cancel-in-progress': true,
      },
      'the newest same-ref sample must replace a runner-less owner without cancelling main from another ref',
    );
    assert.deepEqual(
      workflow.jobs.monitor.environment,
      {
        name: 'ingestion-acceptance-production',
        deployment: false,
      },
      'the Railway token must stay in the main-only environment without deployment tracking',
    );
    assert.equal(workflow.jobs.monitor['timeout-minutes'], 5);
  });
});
