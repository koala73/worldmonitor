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
    const sql = readFileSync(new URL('../scripts/umami-retention.sql', import.meta.url), 'utf8');
    const executableSql = sql.replace(/^\s*--.*$/gmu, '');

    assert.match(workflowSource, /railway volume .* list --json/);
    assert.match(workflowSource, /actions\/cache@/);
    assert.match(workflowSource, /check-umami-storage\.mjs/);
    assert.match(sql, /interval '90 days'/);
    assert.match(sql, /LIMIT 10000/);
    assert.match(sql, /64 \* 1024 \* 1024/);
    assert.match(sql, /pg_advisory_xact_lock/);
    assert.doesNotMatch(executableSql, /\bTRUNCATE\b/);
    assert.match(sql, /to_regclass\('public\.session_link'\)/);
    assert.match(sql, /session_link/);
    assert.match(sql, /heatmap_event/);
    assert.match(sql, /session_replay_saved/);
    assert.doesNotMatch(sql, /ROW_NUMBER/);
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
