import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  evaluateUmamiStorage,
  normalizeVolumeRows,
  parseArguments,
  updateStorageState,
} from '../scripts/check-umami-storage.mjs';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

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
    const workflow = readFileSync(new URL('../.github/workflows/umami-storage-monitor.yml', import.meta.url), 'utf8');
    const sql = readFileSync(new URL('../scripts/umami-retention.sql', import.meta.url), 'utf8');
    const executableSql = sql.replace(/^\s*--.*$/gmu, '');

    assert.match(workflow, /railway volume .* list --json/);
    assert.match(workflow, /actions\/cache@/);
    assert.match(workflow, /check-umami-storage\.mjs/);
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
});
