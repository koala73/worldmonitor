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

// One sample per 15-minute tick, rising linearly to (but excluding) `now`.
function linearSamples({ now, days, currentSizeMB, growthMBPerDay }) {
  const tickMs = 15 * 60 * 1000;
  const samples = [];
  for (let at = now - days * DAY_MS; at < now; at += tickMs) {
    samples.push({
      sampledAt: new Date(at).toISOString(),
      currentSizeMB: currentSizeMB - ((now - at) / DAY_MS) * growthMBPerDay,
    });
  }
  return samples;
}

// Railway refreshes currentSizeMB only every ~6 hours, so the monitor sees a
// staircase. These are the production refreshes that raised the 2026-09-13
// false critical: the last step (+1,078 MB) against a 24-hour baseline read as
// 1.53 GiB/day and 8 days of headroom, while the multi-day trend was ~0.7.
const OBSERVED_REFRESHES = [
  ['2026-09-09T23:47:23Z', 34_730.5],
  ['2026-09-11T00:22:15Z', 35_159.2],
  ['2026-09-11T01:31:36Z', 35_188.5],
  ['2026-09-11T08:32:25Z', 35_314.5],
  ['2026-09-11T14:47:20Z', 35_517.3],
  ['2026-09-11T21:47:08Z', 35_703.3],
  ['2026-09-12T04:08:39Z', 35_775.5],
  ['2026-09-12T10:47:07Z', 35_978.8],
  ['2026-09-12T17:33:22Z', 36_191.1],
  ['2026-09-13T00:24:36Z', 36_279.2],
  ['2026-09-13T06:47:34Z', 37_357.2],
].map(([at, currentSizeMB]) => ({ atMs: Date.parse(at), currentSizeMB }));

function observedStaircaseSamples(now) {
  const tickMs = 15 * 60 * 1000;
  const samples = [];
  for (let at = OBSERVED_REFRESHES[0].atMs; at < now; at += tickMs) {
    const { currentSizeMB } = OBSERVED_REFRESHES.findLast((refresh) => refresh.atMs <= at);
    samples.push({ sampledAt: new Date(at).toISOString(), currentSizeMB });
  }
  return samples;
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

  it('waits for two days of history before projecting, because Railway refreshes in steps', () => {
    const result = evaluateUmamiStorage({
      volume: volume({ currentSizeMB: 28_000 }),
      samples: linearSamples({ now: NOW, days: 1.5, currentSizeMB: 28_000, growthMBPerDay: 5_000 }),
      now: NOW,
    });

    assert.equal(result.growthMBPerDay, null);
    assert.equal(result.projectedHeadroomDays, null);
    assert.equal(result.status, 'healthy');
  });

  it('alerts when projected capacity is inside the 30-day warning window', () => {
    const result = evaluateUmamiStorage({
      volume: volume({ currentSizeMB: 28_000 }),
      samples: linearSamples({ now: NOW, days: 3, currentSizeMB: 28_000, growthMBPerDay: 743 }),
      now: NOW,
    });

    assert.equal(Math.round(result.growthMBPerDay), 743);
    assert.equal(Math.round(result.projectedHeadroomDays), 30);
    assert.equal(result.status, 'warning');
    assert.equal(result.alerting, true);
  });

  it('fits the multi-day trend instead of letting one Railway refresh step set it', () => {
    const now = Date.parse('2026-09-13T11:19:55Z');
    const result = evaluateUmamiStorage({
      volume: volume({ currentSizeMB: 37_357.2 }),
      samples: observedStaircaseSamples(now),
      now,
    });

    // Least squares over the 3-day window reads the staircase as ~740 MB/day.
    // The endpoint slope against a 24h baseline read 1,580 MB/day: critical.
    assert.ok(
      result.growthMBPerDay > 600 && result.growthMBPerDay < 900,
      `growth ${result.growthMBPerDay} MB/day`,
    );
    assert.ok(result.projectedHeadroomDays > 14, `headroom ${result.projectedHeadroomDays} days`);
    assert.equal(result.status, 'warning');
  });

  it('reports no growth when the fitted trend is flat or shrinking', () => {
    const result = evaluateUmamiStorage({
      volume: volume({ currentSizeMB: 28_000 }),
      samples: linearSamples({ now: NOW, days: 3, currentSizeMB: 28_000, growthMBPerDay: -200 }),
      now: NOW,
    });

    assert.equal(result.growthMBPerDay, 0);
    assert.equal(result.projectedHeadroomDays, Infinity);
    assert.equal(result.status, 'healthy');
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
      samples: linearSamples({ now: Date.now(), days: 3, currentSizeMB: 28_000, growthMBPerDay: 743 }),
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

    // The repository's Actions cache sits at its 10 GB cap, so GitHub evicted
    // this history (every entry, on 2026-09-12) and the trend restarted from
    // nothing. The history lives in a workflow artifact instead, which the
    // cache limit does not touch.
    assert.doesNotMatch(workflowSource, /actions\/cache/, 'cache eviction erases the growth history');
    const steps = workflow.jobs.monitor.steps;
    const restoreStep = steps.find((step) => /gh run download/.test(step.run ?? ''));
    const checkStep = steps.find((step) => /check-umami-storage\.mjs/.test(step.run ?? ''));
    const saveStep = steps.find((step) => (step.uses ?? '').startsWith('actions/upload-artifact@'));
    assert.ok(restoreStep, 'the growth history must be restored from the previous run');
    assert.ok(saveStep, 'the growth history must be saved by an explicit step');
    assert.ok(steps.indexOf(restoreStep) < steps.indexOf(checkStep));
    assert.equal(steps.indexOf(saveStep), steps.indexOf(checkStep) + 1);

    // Only this workflow's own runs on the same branch may seed the history, so
    // a same-named artifact from another workflow or ref cannot skew the trend.
    assert.match(restoreStep.run, /actions\/workflows\/umami-storage-monitor\.yml\/runs/);
    // A branch name may contain `&`; interpolated into the URL it would add a
    // query parameter. gh api encodes a GET field instead.
    assert.match(restoreStep.run, /gh api --method GET "[^"?]*\/runs"/);
    assert.match(restoreStep.run, /-f "branch=\$BRANCH"/);
    assert.equal(restoreStep.env.BRANCH, '${{ github.ref_name }}');
    assert.equal(restoreStep.env.GH_TOKEN, '${{ github.token }}');
    assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read' });

    // The check writes its state before it sets a failing exit code, so saving
    // on every uncancelled run keeps the newest sample even on a critical run.
    assert.equal(saveStep.if, '${{ !cancelled() }}');
    assert.equal(saveStep.with.name, restoreStep.run.match(/--name (\S+)/)?.[1]);
    assert.equal(saveStep.with.path, '.cache/umami-storage-state.json');
    // upload-artifact skips dot-directories unless told otherwise.
    assert.equal(saveStep.with['include-hidden-files'], true);
    // A re-run keeps github.run_id, and upload-artifact rejects a second
    // artifact with the same name in one run unless it may replace it.
    assert.equal(saveStep.with.overwrite, true);
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
